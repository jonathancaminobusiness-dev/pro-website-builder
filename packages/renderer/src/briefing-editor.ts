/**
 * The Studio supplies its element factory so this package can own the editor's
 * structure without taking a DOM or React dependency.
 */
export interface BriefingEditorElementFactory<Element> {
  createElement(type: 'div' | 'label' | 'textarea' | 'small' | 'span', props: Record<string, unknown> | null, ...children: Array<Element | string>): Element;
}

export interface BriefingEditorProps {
  value: string;
  maxLength: number;
  onChange: (value: string) => void;
}

function eventValue(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null || !('target' in event)) return undefined;
  const target = (event as { target?: unknown }).target;
  if (typeof target !== 'object' || target === null || !('value' in target)) return undefined;
  const value = (target as { value?: unknown }).value;
  return typeof value === 'string' ? value : undefined;
}

export function renderBriefingEditor<Element>(factory: BriefingEditorElementFactory<Element>, props: BriefingEditorProps): Element {
  const textarea = factory.createElement('textarea', {
    id: 'gate1-briefing',
    value: props.value,
    maxLength: props.maxLength,
    rows: 7,
    onChange: (event: unknown): void => {
      const value = eventValue(event);
      if (value !== undefined) props.onChange(value);
    },
    placeholder: 'Ex.: somos uma oficina de cerâmica autoral; queremos atrair pessoas que valorizam o feito à mão…',
  });
  const meta = factory.createElement('div', { className: 'briefing-meta' },
    factory.createElement('small', null, 'Exemplo editável: conte o nicho, a promessa, as provas e o que a identidade deve evitar.'),
    factory.createElement('span', { 'aria-live': 'polite' }, `${props.value.length}/${props.maxLength} caracteres`),
  );
  return factory.createElement('div', { className: 'briefing-editor' },
    factory.createElement('label', { htmlFor: 'gate1-briefing' }, 'Briefing do projeto'),
    textarea,
    meta,
  );
}
