import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

/**
 * A number field you can actually type a decimal into.
 *
 * The obvious way to write one — `<input type="number">` whose value is
 * `String(theNumber)` — is quietly broken, and broken in the worst direction:
 * it turns the number into a bigger one. Typing 0.03 gives 3, and 12.50 gives
 * 50.
 *
 * The browser is not at fault. Pressing 0 . 0 3 into a number input reports
 * "0", "0", "0.0", "0.03" — the half-typed "0." reads back as "0" because a
 * trailing point is not yet a number. That is the moment it breaks: the parsed
 * value is still 0, so the field re-renders with "0", and React restores the
 * input's text to match, wiping the point that was just typed. Every later
 * digit then lands on a whole number, and 0.03 arrives as 3.
 *
 * So the text being typed is held here, as text, and is never overwritten from
 * the number while the field has focus. The parsed value still goes out on
 * every keystroke, so everything downstream carries on seeing a number. On the
 * way out the text is renormalised from the value, which tidies "0.030" and
 * ".5" without ever having fought the person typing them.
 *
 * The input is type="text" rather than type="number" because that is the only
 * way to be handed "0." at all. inputMode="decimal" keeps the numeric keypad
 * on the phones the floor carries, which is what type="number" was buying.
 */

const show = (n: number): string => (Number.isFinite(n) ? String(n) : '');

/**
 * What a number looks like part-way through being typed: digits, at most one
 * point, and a leading minus only where negatives are allowed. Anything else
 * is dropped as it is typed rather than rejected afterwards.
 */
function clean(raw: string, allowNegative: boolean): string {
  let s = raw.replace(/[^0-9.-]/g, '');
  const negative = allowNegative && s.startsWith('-');
  s = s.replace(/-/g, '');
  const [whole, ...rest] = s.split('.');
  if (rest.length) s = `${whole}.${rest.join('')}`;
  return negative ? `-${s}` : s;
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> & {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
};

export function NumericInput({ value, onChange, min = 0, max, ...rest }: Props) {
  const [text, setText] = useState(() => show(value));
  const typing = useRef(false);

  // Follow the value when something else sets it — a proposal filling the
  // sheet in, a remembered rate being accepted, a row being loaded — but never
  // while it is being typed in, which is the whole point of the component.
  useEffect(() => {
    if (typing.current) return;
    setText(show(value));
  }, [value]);

  const allowNegative = min === undefined || min < 0;

  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      value={text}
      onFocus={(e) => { typing.current = true; rest.onFocus?.(e); }}
      onBlur={(e) => {
        typing.current = false;
        // "0.030", ".5" and "" become 0.03, 0.5 and 0 now that the person has
        // finished — mid-word would have deleted the point they were typing.
        setText(show(value));
        rest.onBlur?.(e);
      }}
      onChange={(e) => {
        const next = clean(e.target.value, allowNegative);
        setText(next);
        const n = Number(next);
        // "", "-" and "." are all real states on the way to a number, and none
        // of them parse. They read as nothing entered, which is zero.
        let out = next === '' || Number.isNaN(n) ? 0 : n;
        if (max !== undefined && out > max) out = max;
        onChange(out);
      }}
    />
  );
}
