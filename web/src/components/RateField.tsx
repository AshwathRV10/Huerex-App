import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * A number field that remembers.
 *
 * When it is empty — or whenever you want to check — it shows the most
 * specific rate the app has seen for this exact context, and says where that
 * number came from: "₹186 · PINK — used on HR-014, three weeks ago". One click
 * accepts it. Typing over it teaches the next order.
 *
 * This is what stops the second order costing as much work as the first.
 */

export interface RateContext {
  kind: 'fabric_component' | 'fabric_flat' | 'trim' | 'jobwork' | 'cmt' | 'overhead' | 'selling_price' | 'consumption';
  buyer?: string; style?: string; fabric_type?: string; colour?: string;
  trim_item?: string; process?: string; vendor?: string; component?: string;
  operation?: string; category?: string; uom?: string;
}

interface Suggestion {
  id: number; rate: number; currency: string; uom: string;
  use_count: number; last_order_no: string; because: string;
  /** a rate the app shipped with, not one this factory has quoted */
  placeholder: boolean;
  exact: boolean;
}

interface Props {
  context: RateContext;
  value: number;
  onChange: (v: number) => void;
  label?: string;
  prefix?: string;
  suffix?: string;
  step?: number;
  disabled?: boolean;
  /** show suggestions even when a value is already present */
  always?: boolean;
  className?: string;
}

export function RateField({
  context, value, onChange, label, prefix = '₹', suffix, step = 0.01,
  disabled, always = false, className,
}: Props) {
  const id = useId();
  const [touched, setTouched] = useState(false);

  // Only asks the server once the context is specific enough to be useful.
  const ready = Boolean(context.kind) && Object.values(context).filter(Boolean).length > 1;
  const { data } = useQuery({
    queryKey: ['rate-suggest', context],
    queryFn: () => api.get<Suggestion[]>('/api/rates/suggest', { ...context }),
    enabled: ready && !disabled,
    staleTime: 120_000,
  });

  const best = data?.[0];
  const emptyValue = !value || value === 0;
  const differs = best !== undefined && Math.abs(best.rate - value) > 0.0001;

  // The field is already carrying a rate the app shipped with. This is the
  // case that most needs saying out loud: the number looks like every other
  // number on the sheet, and it is the one nobody has ever quoted.
  const holdingPlaceholder = Boolean(best?.placeholder) && !emptyValue && !differs;

  const show = Boolean(best) && !disabled
    && (emptyValue || holdingPlaceholder || (always && differs) || (touched && differs));

  return (
    <div className={`field rate-field ${className ?? ''}`}>
      {label && <label htmlFor={id}>{label}</label>}
      <div className="input-affix">
        {prefix && <span className="prefix">{prefix}</span>}
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className="input input-num"
          step={step}
          min={0}
          disabled={disabled}
          value={Number.isFinite(value) ? String(value) : ''}
          placeholder={best ? String(best.rate) : '0'}
          onFocus={() => setTouched(true)}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>

      {show && best && (
        holdingPlaceholder ? (
          // Nothing to click — the value is already this. It is a caution, not an offer.
          <span className="rate-because is-placeholder" role="note">
            <span className="memo">!</span>
            <span className="truncate">A starting point — replace with your real rate</span>
          </span>
        ) : (
          <button
            type="button"
            className={`rate-because ${best.placeholder ? 'is-placeholder' : ''}`}
            title={best.placeholder
              ? 'A starting point the app shipped with. Use it only until you know the real rate.'
              : 'Use this remembered rate'}
            onClick={() => onChange(best.rate)}
          >
            <span className="memo">{prefix}{best.rate}</span>
            <span className="truncate">{best.because}</span>
          </button>
        )
      )}
    </div>
  );
}

/** Plain number field, matching RateField's shape so rows line up. */
export function NumField({
  label, value, onChange, suffix, prefix, step = 1, min = 0, max, disabled, help, className, placeholder,
}: {
  label?: string; value: number; onChange: (v: number) => void;
  suffix?: string; prefix?: string; step?: number; min?: number; max?: number;
  disabled?: boolean; help?: string; className?: string; placeholder?: string;
}) {
  const id = useId();
  return (
    <div className={`field ${className ?? ''}`}>
      {label && <label htmlFor={id}>{label}</label>}
      <div className="input-affix">
        {prefix && <span className="prefix">{prefix}</span>}
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className="input input-num"
          step={step} min={min} max={max}
          disabled={disabled}
          placeholder={placeholder}
          value={Number.isFinite(value) ? String(value) : ''}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
      {help && <span className="help">{help}</span>}
    </div>
  );
}

export function TextField({
  label, value, onChange, placeholder, disabled, help, error, className, type = 'text', autoFocus, required,
}: {
  label?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; disabled?: boolean; help?: string; error?: string;
  className?: string; type?: string; autoFocus?: boolean; required?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field ${className ?? ''}`}>
      {label && (
        <label htmlFor={id}>
          {label}{required && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
        </label>
      )}
      <input
        id={id}
        type={type}
        className="input"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <span className="err">{error}</span> : help ? <span className="help">{help}</span> : null}
    </div>
  );
}

export function SelectField({
  label, value, onChange, options, disabled, help, className,
}: {
  label?: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean; help?: string; className?: string;
}) {
  const id = useId();
  return (
    <div className={`field ${className ?? ''}`}>
      {label && <label htmlFor={id}>{label}</label>}
      <select id={id} className="select" value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {help && <span className="help">{help}</span>}
    </div>
  );
}

export function DateField({
  label, value, onChange, disabled, help, className, required,
}: {
  label?: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; help?: string; className?: string; required?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field ${className ?? ''}`}>
      {label && (
        <label htmlFor={id}>
          {label}{required && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
        </label>
      )}
      <input id={id} type="date" className="input" value={value ?? ''} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} />
      {help && <span className="help">{help}</span>}
    </div>
  );
}
