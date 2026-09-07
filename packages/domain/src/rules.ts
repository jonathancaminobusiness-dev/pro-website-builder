export const documentRules = {
  mediaFigure: 'A media node renders as figure, and only a media node may declare figure.',
  phrasingLeaf: 'A node whose semantic is h1, h2, h3 or p carries its own text and must declare no slot children.',
  pageGraph: 'Node ids are unique within a page, and every node a page lists is reachable exactly once by following slots from its rootNodeId.',
  uniquePages: 'Page ids and page routes are unique across the document; routes are compared case-insensitively.',
  tokenRoles: 'Every tokenRoles entry must name a token path the identity itself defines.',
  cssTokens: 'Every token path must compile to a distinct CSS custom property built from letters, digits and hyphens only, and no token value may contain < > ; { } or a CSS comment delimiter.',
} as const;
