import { describe, expect, it } from 'vitest';
import { renderBriefingEditor, type BriefingEditorElementFactory } from './briefing-editor.js';

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
});
