import { useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

// value and onChange use YYYY-MM-DD strings (same as <input type="date">)
export default function DatePicker({ value, onChange, placeholder = 'Pick a date', className = '' }) {
  const [open, setOpen]       = useState(false);
  const [viewYear, setYear]   = useState(() => value ? parseInt(value.slice(0,4)) : new Date().getFullYear());
  const [viewMonth, setMonth] = useState(() => value ? parseInt(value.slice(5,7)) - 1 : new Date().getMonth());
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Sync view when value changes externally
  useEffect(() => {
    if (value) {
      setYear(parseInt(value.slice(0,4)));
      setMonth(parseInt(value.slice(5,7)) - 1);
    }
  }, [value]);

  const today     = new Date();
  const todayStr  = toStr(today.getFullYear(), today.getMonth(), today.getDate());
  const selected  = value || null;

  function toStr(y, m, d) {
    return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  function displayValue() {
    if (!value) return '';
    const [y, m, d] = value.split('-').map(Number);
    return `${MONTHS[m-1].slice(0,3)} ${d}, ${y}`;
  }

  function prevMonth() {
    if (viewMonth === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }

  function buildGrid() {
    const first = new Date(viewYear, viewMonth, 1).getDay();
    const days  = new Date(viewYear, viewMonth + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    return cells;
  }

  function select(d) {
    if (!d) return;
    const str = toStr(viewYear, viewMonth, d);
    onChange(str);
    setOpen(false);
  }

  const cells = buildGrid();

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* Trigger */}
      <div
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-fg cursor-pointer hover:border-border-strong focus-within:ring-2 focus-within:ring-primary/20 select-none"
      >
        <Calendar size={13} className="text-fg-muted shrink-0" />
        <span className={value ? 'text-fg' : 'text-fg-subtle'}>
          {value ? displayValue() : placeholder}
        </span>
        {value && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
            className="ml-auto text-border-strong hover:text-fg-muted transition-colors"
          >
            ×
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1.5 bg-surface border border-border rounded-xl shadow-lg p-3 w-64">
          {/* Month/Year nav */}
          <div className="flex items-center justify-between mb-3">
            <button type="button" onClick={prevMonth} className="p-1 rounded-lg hover:bg-muted text-fg-muted hover:text-fg transition-colors">
              <ChevronLeft size={15} />
            </button>
            <span className="text-sm font-semibold text-fg">
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button type="button" onClick={nextMonth} className="p-1 rounded-lg hover:bg-muted text-fg-muted hover:text-fg transition-colors">
              <ChevronRight size={15} />
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 mb-1">
            {DAYS.map(d => (
              <div key={d} className="text-center text-[10px] font-semibold text-fg-muted uppercase py-1">{d}</div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((d, i) => {
              if (!d) return <div key={`e-${i}`} />;
              const str       = toStr(viewYear, viewMonth, d);
              const isToday   = str === todayStr;
              const isSel     = str === selected;
              return (
                <button
                  type="button"
                  key={str}
                  onClick={() => select(d)}
                  className={`
                    text-xs rounded-lg h-8 w-full flex items-center justify-center font-medium transition-colors
                    ${isSel
                      ? 'bg-primary text-white'
                      : isToday
                      ? 'bg-primary/10 text-primary font-semibold'
                      : 'text-fg hover:bg-muted'}
                  `}
                >
                  {d}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex justify-between items-center mt-3 pt-2.5 border-t border-border-subtle">
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false); }}
              className="text-xs text-fg-muted hover:text-danger transition-colors font-medium"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                const t = new Date();
                select(t.getDate());
                setYear(t.getFullYear());
                setMonth(t.getMonth());
              }}
              className="text-xs text-primary hover:text-primary/80 transition-colors font-semibold"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
