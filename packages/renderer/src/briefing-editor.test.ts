import { describe, expect, it } from 'vitest';
import { renderBriefingCreateButton, renderBriefingEditor, renderBriefingReplacementConfirmation, renderBriefingReplacementOffer, type BriefingEditorElementFactory } from './briefing-editor.js';

interface TestElement { type: string; props: Record<string, unknown> | null; children: Array<TestElement | string>; }

const factory: BriefingEditorElementFactory<TestElement> = {
  createElement(type, props, ...children) { return { type, props, children: children as Array<TestElement | string> }; },
};

function textOf(element: TestElement): string {
  return element.children.map((child) => typeof child === 'string' ? child : textOf(child)).join('');
}

describe('briefing editor renderer API', () => {
  it('owns the editor structure and forwards the supported value contract', () => {
    let changed = '';
    const editor = renderBriefingEditor(factory, { value: 'Brief', maxLength: 8000, onChange: (value) => { changed = value; } });

    expect(editor.type).toBe('div');
    expect(editor.props).toMatchObject({ className: 'briefing-editor' });
    const label = editor.children[0] as TestElement;
    const textarea = editor.children[1] as TestElement;
    const meta = editor.children[2] as TestElement;
    expect(label).toMatchObject({ type: 'label', props: { htmlFor: 'gate1-briefing' } });
    expect(textarea).toMatchObject({ type: 'textarea', props: { id: 'gate1-briefing', value: 'Brief', maxLength: 8000, rows: 7 } });
    expect(textOf(meta)).toContain('Exemplo editável');
    expect(textOf(meta)).toContain('5/8000 caracteres');

    const onChange = textarea.props?.onChange as (event: unknown) => void;
    onChange({ target: { value: 'Updated' } });
    expect(changed).toBe('Updated');
  });

  it('owns the creation control and forwards its callback and disabled state', () => {
    let created = 0;
    const button = renderBriefingCreateButton(factory, { disabled: true, onCreate: () => { created += 1; } });

    expect(button).toMatchObject({ type: 'button', props: { className: 'primary', disabled: true } });
    expect(textOf(button)).toBe('Criar execução de identidade');
    (button.props?.onClick as () => void)();
    expect(created).toBe(1);
  });

  it('owns the replacement confirmation controls and forwards both callbacks', () => {
    let kept = 0;
    let created = 0;
    const confirmation = renderBriefingReplacementConfirmation(factory, {
      replacing: 'identity-123',
      disabled: true,
      onKeep: () => { kept += 1; },
      onCreate: () => { created += 1; },
    });

    expect(confirmation).toMatchObject({ type: 'div', props: { className: 'token-form open-run', role: 'group' } });
    expect(textOf(confirmation)).toContain('identity-123');
    const keep = confirmation.children[1] as TestElement;
    const create = confirmation.children[2] as TestElement;
    expect(keep).toMatchObject({ type: 'button', props: { className: 'secondary', disabled: true } });
    expect(create).toMatchObject({ type: 'button', props: { className: 'primary', disabled: true } });
    (keep.props?.onClick as () => void)();
    (create.props?.onClick as () => void)();
    expect(kept).toBe(1);
    expect(created).toBe(1);
  });

  it('owns the replacement offer and forwards its disabled state and callback', () => {
    let opened = 0;
    const offer = renderBriefingReplacementOffer(factory, { label: 'Nova execução', disabled: false, onOpen: () => { opened += 1; } });

    expect(offer).toMatchObject({ type: 'button', props: { className: 'secondary', disabled: false } });
    expect(textOf(offer)).toBe('Nova execução');
    (offer.props?.onClick as () => void)();
    expect(opened).toBe(1);
  });
});
