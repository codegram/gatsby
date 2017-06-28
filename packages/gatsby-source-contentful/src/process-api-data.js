const _ = require(`lodash`)
const crypto = require(`crypto`)
const stringify = require(`json-stringify-safe`)

const digest = str => crypto.createHash(`md5`).update(str).digest(`hex`)
const typePrefix = `Contentful`
const makeTypeName = type => _.upperFirst(_.camelCase(`${typePrefix} ${type}`))

const getLocalizedField = ({ field, defaultLocale, currentLocale }) => {
  if (field[currentLocale]) {
    return field[currentLocale]
  } else {
    return field[defaultLocale]
  }
}

const makeGetLocalizedField = ({ currentLocale, defaultLocale }) => field =>
  getLocalizedField({ field, currentLocale, defaultLocale })

exports.getLocalizedField = getLocalizedField

// If the id starts with a number, left-pad it with a c (for Contentful of
// course :-))
const fixId = id => {
  if (!isNaN(id.slice(0, 1))) {
    return `c${id}`
  }

  return id
}
exports.fixId = fixId

const mapValuesDeep = (v, k, callback) => {
  if (_.isArray(v)) {
    return v.map(n => mapValuesDeep(n, null, callback))
  } else {
    return _.isObject(v)
      ? _.mapValues(v, (v, k) => mapValuesDeep(v, k, callback))
      : callback(v, k)
  }
}

exports.fixIds = object =>
  mapValuesDeep(object, null, (v, k) => (k === `id` ? fixId(v) : v))

const makeId = ({ id, currentLocale, defaultLocale }) =>
  currentLocale === defaultLocale ? id : `${id} ${currentLocale}`

exports.makeId = makeId

const makeMakeId = ({ currentLocale, defaultLocale }) => id =>
  makeId({ id, currentLocale, defaultLocale })

exports.buildEntryList = ({ contentTypeItems, currentSyncData }) =>
  contentTypeItems.map(contentType =>
    currentSyncData.entries.filter(
      entry => entry.sys.contentType.sys.id === contentType.sys.id
    )
  )

exports.buildResolvableSet = ({
  entryList,
  existingNodes = [],
  assets = [],
  currentLocale,
  defaultLocale,
}) => {
  const mId = makeMakeId({ currentLocale, defaultLocale })
  const resolvable = new Set()
  existingNodes.forEach(n => resolvable.add(n.id))

  entryList.forEach(entries => {
    entries.forEach(entry => {
      resolvable.add(mId(entry.sys.id))
    })
  })
  assets.forEach(assetItem => resolvable.add(mId(assetItem.sys.id)))

  return resolvable
}

exports.buildForeignReferenceMap = ({
  contentTypeItems,
  entryList,
  resolvable,
  defaultLocale,
  currentLocale,
}) => {
  const mId = makeMakeId({ currentLocale, defaultLocale })
  const getField = makeGetLocalizedField({ currentLocale, defaultLocale })
  const foreignReferenceMap = {}
  contentTypeItems.forEach((contentTypeItem, i) => {
    const contentTypeItemId = contentTypeItem.name.toLowerCase()
    entryList[i].forEach(entryItem => {
      const entryItemFields = entryItem.fields
      Object.keys(entryItemFields).forEach(entryItemFieldKey => {
        if (getField(entryItemFields[entryItemFieldKey])) {
          let entryItemFieldValue = getField(entryItemFields[entryItemFieldKey])
          if (Array.isArray(entryItemFieldValue)) {
            if (
              entryItemFieldValue[0].sys &&
              entryItemFieldValue[0].sys.type &&
              entryItemFieldValue[0].sys.id
            ) {
              entryItemFieldValue.forEach(v => {
                // Don't create link to an unresolvable field.
                if (!resolvable.has(mId(v.sys.id))) {
                  return
                }

                if (!foreignReferenceMap[mId(v.sys.id)]) {
                  foreignReferenceMap[mId(v.sys.id)] = []
                }
                foreignReferenceMap[mId(v.sys.id)].push({
                  name: `${contentTypeItemId}___NODE`,
                  id: mId(entryItem.sys.id),
                })
              })
            }
          } else if (
            entryItemFieldValue.sys &&
            entryItemFieldValue.sys.type &&
            entryItemFieldValue.sys.id &&
            resolvable.has(mId(entryItemFieldValue.sys.id))
          ) {
            if (!foreignReferenceMap[mId(entryItemFieldValue.sys.id)]) {
              foreignReferenceMap[mId(entryItemFieldValue.sys.id)] = []
            }
            foreignReferenceMap[mId(entryItemFieldValue.sys.id)].push({
              name: `${contentTypeItemId}___NODE`,
              id: mId(entryItem.sys.id),
            })
          }
        }
      })
    })
  })

  return foreignReferenceMap
}

function createTextNode(node, key, text, createNode) {
  const str = _.isString(text) ? text : ` `
  const textNode = {
    id: `${node.id}${key}TextNode`,
    parent: node.id,
    children: [],
    [key]: str,
    internal: {
      type: _.camelCase(`${node.internal.type} ${key} TextNode`),
      mediaType: `text/x-markdown`,
      content: str,
      contentDigest: digest(str),
    },
  }

  node.children = node.children.concat([textNode.id])
  createNode(textNode)

  return textNode.id
}
exports.createTextNode = createTextNode

exports.createContentTypeNodes = ({
  contentTypeItem,
  restrictedNodeFields,
  conflictFieldPrefix,
  entries,
  createNode,
  resolvable,
  foreignReferenceMap,
  defaultLocale,
  currentLocale,
}) => {
  const contentTypeItemId = contentTypeItem.name
  const mId = makeMakeId({ currentLocale, defaultLocale })
  const getField = makeGetLocalizedField({ currentLocale, defaultLocale })

  // Warn about any field conflicts
  const conflictFields = []
  contentTypeItem.fields.forEach(contentTypeItemField => {
    const fieldName = contentTypeItemField.id
    if (restrictedNodeFields.includes(fieldName)) {
      console.log(
        `Restricted field found for ContentType ${contentTypeItemId} and field ${fieldName}. Prefixing with ${conflictFieldPrefix}.`
      )
      conflictFields.push(fieldName)
    }
  })

  // First create nodes for each of the entries of that content type
  const entryNodes = entries.map(entryItem => {
    // Prefix any conflicting fields
    // https://github.com/gatsbyjs/gatsby/pull/1084#pullrequestreview-41662888
    const entryItemFields = entryItem.fields
    conflictFields.forEach(conflictField => {
      entryItemFields[`${conflictFieldPrefix}${conflictField}`] =
        entryItemFields[conflictField]
      delete entryItemFields[conflictField]
    })

    // Add linkages to other nodes based on foreign references
    Object.keys(entryItemFields).forEach(entryItemFieldKey => {
      if (getField(entryItemFields[entryItemFieldKey])) {
        const entryItemFieldValue = getField(entryItemFields[entryItemFieldKey])
        if (Array.isArray(entryItemFieldValue)) {
          if (
            entryItemFieldValue[0].sys &&
            entryItemFieldValue[0].sys.type &&
            entryItemFieldValue[0].sys.id
          ) {
            entryItemFields[
              `${entryItemFieldKey}___NODE`
            ] = entryItemFieldValue
              .filter(v => resolvable.has(mId(v.sys.id)))
              .map(v => mId(v.sys.id))

            delete entryItemFields[entryItemFieldKey]
          }
        } else if (
          entryItemFieldValue.sys &&
          entryItemFieldValue.sys.type &&
          entryItemFieldValue.sys.id &&
          resolvable.has(mId(entryItemFieldValue.sys.id))
        ) {
          entryItemFields[`${entryItemFieldKey}___NODE`] = mId(
            entryItemFieldValue.sys.id
          )
          delete entryItemFields[entryItemFieldKey]
        }
      }
    })

    // Add reverse linkages if there are any for this node
    const foreignReferences = foreignReferenceMap[mId(entryItem.sys.id)]
    if (foreignReferences) {
      foreignReferences.forEach(foreignReference => {
        const existingReference = entryItemFields[foreignReference.name]
        if (existingReference) {
          entryItemFields[foreignReference.name].push(foreignReference.id)
        } else {
          // If is one foreign reference, there can always be many.
          // Best to be safe and put it in an array to start with.
          entryItemFields[foreignReference.name] = [foreignReference.id]
        }
      })
    }

    let entryNode = {
      id: mId(entryItem.sys.id),
      parent: contentTypeItemId,
      children: [],
      internal: {
        type: `${makeTypeName(contentTypeItemId)}`,
        mediaType: `application/x-contentful`,
      },
    }

    // Use default locale field.
    Object.keys(entryItemFields).forEach(entryItemFieldKey => {
      // Ignore fields with "___node" as they're already handled
      // and won't be a text field.
      if (entryItemFieldKey.split(`___`).length > 1) {
        return
      }

      entryItemFields[entryItemFieldKey] = getField(
        entryItemFields[entryItemFieldKey]
      )
    })

    // Replace text fields with text nodes so we can process their markdown
    // into HTML.
    Object.keys(entryItemFields).forEach(entryItemFieldKey => {
      // Ignore fields with "___node" as they're already handled
      // and won't be a text field.
      if (entryItemFieldKey.split(`___`).length > 1) {
        return
      }

      const fieldType = contentTypeItem.fields.find(
        f =>
          (restrictedNodeFields.includes(f.id)
            ? `${conflictFieldPrefix}${f.id}`
            : f.id) === entryItemFieldKey
      ).type
      if (fieldType === `Text`) {
        entryItemFields[`${entryItemFieldKey}___NODE`] = createTextNode(
          entryNode,
          entryItemFieldKey,
          entryItemFields[entryItemFieldKey],
          createNode
        )

        delete entryItemFields[entryItemFieldKey]
      }
    })

    entryNode = { ...entryItemFields, ...entryNode }

    // Get content digest of node.
    const contentDigest = digest(stringify(entryNode))

    entryNode.internal.contentDigest = contentDigest

    return entryNode
  })

  // Create a node for each content type
  const contentTypeNode = {
    id: contentTypeItemId,
    parent: `__SOURCE__`,
    children: [],
    name: contentTypeItem.name,
    displayField: contentTypeItem.displayField,
    description: contentTypeItem.description,
    internal: {
      type: `${makeTypeName(`ContentType`)}`,
      mediaType: `text/x-contentful`,
    },
  }

  // Get content digest of node.
  const contentDigest = digest(stringify(contentTypeNode))

  contentTypeNode.internal.contentDigest = contentDigest

  createNode(contentTypeNode)
  entryNodes.forEach(entryNode => {
    createNode(entryNode)
  })
}

exports.createAssetNodes = ({
  assetItem,
  createNode,
  defaultLocale,
  currentLocale,
}) => {
  const mId = makeMakeId({ currentLocale, defaultLocale })
  const getField = makeGetLocalizedField({ currentLocale, defaultLocale })

  // Create a node for each asset. They may be referenced by Entries
  assetItem.fields = {
    file: getField(assetItem.fields.file),
    title: assetItem.fields.title ? getField(assetItem.fields.title) : ``,
    description: assetItem.fields.description
      ? getField(assetItem.fields.description)
      : ``,
  }
  const assetNode = {
    id: mId(assetItem.sys.id),
    parent: `__SOURCE__`,
    children: [],
    ...assetItem.fields,
    internal: {
      type: `${makeTypeName(`Asset`)}`,
      mediaType: `text/x-contentful`,
    },
  }

  // Get content digest of node.
  const contentDigest = digest(stringify(assetNode))

  assetNode.internal.contentDigest = contentDigest

  createNode(assetNode)
}
