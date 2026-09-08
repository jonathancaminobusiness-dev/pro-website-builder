import { describe, expect, it } from 'vitest';
import { createFixtureIR, type DesignIR, type PageNode } from '@pwb/domain';
import { lintDesign, prototypeRuleRegistry, ruleRegistry } from './index.js';

function node(id: string, kind: PageNode['kind'], semantic: PageNode['semantic'], props: PageNode['props'] = {}, slots: Record<string, string[]> = {}): PageNode {
  return { id, kind, semantic, props, slots, responsive: [] };
}

function findings(ir: DesignIR, id: string): string[] {
  return lintDesign(ir).findings.filter((finding) => finding.id === id).map((finding) => finding.message);
}

describe('prototype rule registry', () => {
  it('registers the seven prototype rules through the shared registry', () => {
    expect(prototypeRuleRegistry.map((rule) => rule.id)).toEqual(['STR-020', 'GRID-040', 'TYPE-050', 'COH-070', 'MOTION-080', 'A11Y-090', 'COPY-110']);
    expect(ruleRegistry.map((rule) => rule.id)).toEqual(['TOK-001', 'TOK-002', 'TOK-003', 'TOK-004', 'ID-003', 'DIV-030', 'DEF-010', 'DOC-020', 'STR-020', 'GRID-040', 'TYPE-050', 'COH-070', 'MOTION-080', 'A11Y-090', 'COPY-110']);
    expect(prototypeRuleRegistry.filter((rule) => rule.severity === 'error').map((rule) => rule.id)).toEqual(['A11Y-090', 'COPY-110']);
    expect(prototypeRuleRegistry.every((rule) => rule.stage === 'prototype')).toBe(true);
  });

  it('leaves the clean fixture alone', () => {
    expect(lintDesign(createFixtureIR()).findings).toEqual([]);
  });
});

describe('STR-020 structural defaults', () => {
  it('names a hero over three interchangeable blocks', () => {
    const ir = createFixtureIR();
    const cards = ['card-a', 'card-b', 'card-c'].map((id) => node(id, 'surface', 'section', { padding: '{space.md}', text: `Bloco ${id}` }));
    ir.pages.routes[0]!.nodes = [
      node('home-root', 'stack', 'div', { background: '{color.paper}', color: '{color.ink}' }, { children: ['home-title', ...cards.map((card) => card.id)] }),
      node('home-title', 'type', 'h1', { text: 'Toda escolha tem motivo.', font: '{type.display}' }),
      ...cards,
    ];
    expect(findings(ir, 'STR-020')[0]).toContain('arranjo padrão de título sobre três blocos idênticos');
  });

  it('names two routes that repeat the same tree, and ignores pages too small to carry a signal', () => {
    const ir = createFixtureIR();
    expect(findings(ir, 'STR-020')).toEqual([]);
    const shape = (prefix: string): PageNode[] => [
      node(`${prefix}-root`, 'stack', 'div', { background: '{color.paper}', color: '{color.ink}' }, { children: [`${prefix}-title`, `${prefix}-body`, `${prefix}-note`] }),
      node(`${prefix}-title`, 'type', 'h1', { text: 'Título', font: '{type.display}' }),
      node(`${prefix}-body`, 'type', 'p', { text: 'Corpo', font: '{type.body}' }),
      node(`${prefix}-note`, 'type', 'p', { text: 'Nota', font: '{type.body}' }),
    ];
    ir.pages.routes[1] = { id: 'page-proof', route: '/proof', title: 'Prova', rootNodeId: 'proof-root', nodes: shape('proof') };
    ir.pages.routes[2] = { id: 'page-contact', route: '/contact', title: 'Contato', rootNodeId: 'contact-root', nodes: shape('contact') };
    expect(findings(ir, 'STR-020')[0]).toContain('As rotas /proof e /contact repetem a mesma árvore');
  });
});

describe('GRID-040, TYPE-050 and MOTION-080', () => {
  it('names spacing outside the declared rhythm and offers the token that fixes it', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.props.gap = '{space.sm}';
    const report = lintDesign(ir).findings.filter((finding) => finding.id === 'GRID-040');
    expect(report[0]!.message).toContain('fora do ritmo de 24px');
    expect(report[0]!.suggestedPatch).toEqual({ operation: 'set_token', nodeId: 'home-root', prop: 'gap', token: '{space.md}' });
  });

  it('names a text node with no typographic role and a family with no fallback', () => {
    const ir = createFixtureIR();
    delete ir.pages.routes[0]!.nodes[1]!.props.font;
    expect(findings(ir, 'TYPE-050')[0]).toContain('sem papel tipográfico');
    const noFallback = createFixtureIR();
    noFallback.identity.tokens = { ...noFallback.identity.tokens, type: { display: { $value: 'Fraunces', $type: 'fontFamily' }, body: { $value: 'Inter, Arial, sans-serif', $type: 'fontFamily' } } };
    expect(findings(noFallback, 'TYPE-050')[0]).toContain('sem fallback');
  });

  it('names movement with no reduced-motion answer and movement pointed at the wrong kind of token', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[1]!.props.motion = '{motion.quick}';
    expect(findings(ir, 'MOTION-080')).toEqual([]);
    delete ir.stateFixtures.reduced;
    expect(findings(ir, 'MOTION-080')[0]).toContain('nenhum estado declara movimento reduzido');
    const wrongType = createFixtureIR();
    wrongType.pages.routes[0]!.nodes[1]!.props.motion = '{color.accent}';
    expect(findings(wrongType, 'MOTION-080')[0]).toContain('não é um token de duração nem de curva');
  });
});

describe('COH-070 coherence', () => {
  it('names a state that points at a node the graph does not declare', () => {
    const ir = createFixtureIR();
    ir.stateFixtures.error = { description: 'Falha', values: { motion: 'full', hidden: 'home-title, ghost-node', focus: 'other-ghost' } };
    const messages = findings(ir, 'COH-070');
    expect(messages.join(' ')).toContain('ghost-node');
    expect(messages.join(' ')).toContain('other-ghost');
    expect(messages).toHaveLength(2);
  });

  it('names a route root that stops using the approved token roles', () => {
    const ir = createFixtureIR();
    ir.pages.routes[1]!.nodes[0]!.props.background = '{color.accent}';
    expect(findings(ir, 'COH-070')[0]).toContain('em vez do papel de superfície {color.paper}');
  });
});

describe('A11Y-090 and COPY-110', () => {
  it('names a route with no h1 and a heading hierarchy that skips a level', () => {
    const ir = createFixtureIR();
    ir.pages.routes[1]!.nodes[1]!.semantic = 'h2';
    expect(findings(ir, 'A11Y-090')[0]).toContain('/proof não declara um h1');
    const skipping = createFixtureIR();
    skipping.pages.routes[0]!.nodes.push(node('home-sub', 'type', 'h3', { text: 'Sub', font: '{type.body}' }));
    skipping.pages.routes[0]!.nodes[0]!.slots = { children: ['home-title', 'home-proof', 'home-sub'] };
    expect(findings(skipping, 'A11Y-090')[0]).toContain('salta de h1 para h3');
  });

  it('names a generic control label and leaves a specific one alone', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes.push(
      node('cta-generic', 'component', 'link', { color: '{color.ink}', text: 'Saiba mais', href: '/proof' }),
      node('cta-specific', 'component', 'link', { color: '{color.ink}', text: 'Ver a prova', href: '/proof' }),
    );
    ir.pages.routes[0]!.nodes[0]!.slots = { children: ['home-title', 'home-proof', 'cta-generic', 'cta-specific'] };
    const messages = findings(ir, 'A11Y-090').join(' | ');
    expect(messages).toContain('rótulo genérico "Saiba mais"');
    expect(messages).not.toContain('cta-specific');
  });

  it('names placeholder copy, empty copy and the vocabulary the identity forbids', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[1]!.props.text = 'Aguardando composição.';
    ir.pages.routes[1]!.nodes[1]!.props.text = '   ';
    ir.pages.routes[2]!.nodes[1]!.props.text = 'Um resultado revolucionário para a sua marca.';
    const messages = findings(ir, 'COPY-110');
    expect(messages.join(' | ')).toContain('ainda carrega texto de espera');
    expect(messages.join(' | ')).toContain('declara texto vazio');
    expect(messages.join(' | ')).toContain('usa "revolucionário", que o contrato de conteúdo proíbe');
    expect(lintDesign(ir).errorCount).toBeGreaterThanOrEqual(3);
  });
});
