export const documentRules = {
  mediaFigure: 'A media node renders as figure, and only a media node may declare figure.',
  phrasingLeaf: 'A node whose semantic is h1, h2, h3, p, link or button carries its own text and must declare no slot children.',
  interactiveControl: 'A link or a button is a component node whose text is its label; only a link declares href, and that href must be a route of this site.',
  pageGraph: 'Node ids are unique across the document, and every node a page lists is reachable exactly once by following slots from its rootNodeId.',
  uniquePages: 'Page ids and page routes are unique across the document; routes are compared case-insensitively.',
  tokenRoles: 'Every tokenRoles entry must name a token path the identity itself defines.',
  cssTokens: 'Every token path must compile to a distinct CSS custom property built from letters, digits and hyphens only, and no token value, once its aliases are resolved, may contain < > ; { } or a CSS comment delimiter, or leave a parenthesis unbalanced.',
  tokenReferences: 'Every token alias and every visual prop reference must name a token path the identity defines.',
  visualPropTokens: 'Every visual prop a node declares must be written as a token reference such as {color.ink}; a raw literal value is never renderable.',
  mediaAsset: 'Only a media node may declare assetId, it must name an asset the document lists, and a ready asset a node references must carry non-empty alt text and a data: URI the preview and export policies can display.',
  responsiveWidths: 'A node declares at most one responsive rule per container width, and both the width and every prop it sets resolve through tokens.',
} as const;
