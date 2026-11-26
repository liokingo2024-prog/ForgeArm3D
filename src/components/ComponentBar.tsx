import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SLOT_ORDER, SLOT_SPECS } from '../data/catalog';
import { ResolvedMechanics, SlotId, WeaponConfig } from '../types/weapon';

interface Props {
  config: WeaponConfig;
  mechanics: ResolvedMechanics;
  activeSlot: SlotId;
  onSelectSlot: (slot: SlotId) => void;
  onHoverSlot: (slot: SlotId | null) => void;
}

export function ComponentBar({
  config,
  mechanics,
  activeSlot,
  onSelectSlot,
  onHoverSlot,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Partial<Record<SlotId, HTMLButtonElement | null>>>({});
  const [fadeLeft, setFadeLeft] = useState(false);
  const [fadeRight, setFadeRight] = useState(false);

  const updateScrollFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFadeLeft(el.scrollLeft > 4);
    setFadeRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollFades();
    const ro = new ResizeObserver(updateScrollFades);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateScrollFades]);

  useEffect(() => {
    const activeBtn = itemRefs.current[activeSlot];
    if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
      activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }
  }, [activeSlot]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = SLOT_ORDER.indexOf(activeSlot);
    if (idx < 0) return;
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % SLOT_ORDER.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + SLOT_ORDER.length) % SLOT_ORDER.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = SLOT_ORDER.length - 1;

    if (nextIdx !== null) {
      e.preventDefault();
      const nextSlot = SLOT_ORDER[nextIdx];
      onSelectSlot(nextSlot);
      itemRefs.current[nextSlot]?.focus();
    }
  };

  return (
    <nav
      aria-label="Weapon components"
      className="relative shrink-0 border-b border-[#1D222C] bg-[#0D1016]"
    >
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Weapon component slots"
        aria-orientation="horizontal"
        onScroll={updateScrollFades}
        onKeyDown={handleKeyDown}
        className="no-scrollbar flex h-9 w-full items-stretch gap-0.5 overflow-x-auto px-2"
      >
        {SLOT_ORDER.map((slotId, index) => {
          const spec = SLOT_SPECS[slotId];
          const variantId = (config.parts as unknown as Record<string, string>)[slotId];
          const variant = spec.variants.find((v) => v.id === variantId) ?? spec.variants[0];
          const off =
            variantId === 'none' ||
            (slotId === 'underbarrel' && mechanics.underbarrelDisabledByHandguard);
          const selected = slotId === activeSlot;

          return (
            <button
              key={slotId}
              ref={(node) => {
                itemRefs.current[slotId] = node;
              }}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={`${spec.label}: ${off ? 'None' : variant.name} (Key ${index + 1})`}
              onClick={() => onSelectSlot(slotId)}
              onMouseEnter={() => onHoverSlot(slotId)}
              onMouseLeave={() => onHoverSlot(null)}
              className={`relative flex items-center gap-1.5 px-2.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#F59E0B]/70 ${
                selected
                  ? 'bg-[#161B25] text-[#F8FAFC]'
                  : off
                    ? 'text-[#556072] hover:bg-[#131720] hover:text-[#98A3B5]'
                    : 'text-[#A2ADBF] hover:bg-[#131720] hover:text-[#EEF2F7]'
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-[2px] ${
                  off
                    ? 'border border-dashed border-[#465063] bg-transparent'
                    : 'border border-white/15'
                }`}
                style={
                  off
                    ? undefined
                    : { backgroundColor: config.paints[slotId].primaryColor }
                }
              />
              <span>{spec.label}</span>
              {selected && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-1.5 bottom-0 h-[2px] rounded-t-full bg-[#F59E0B]"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Subtle directional scroll-hint edge fades only when horizontal overflow exists */}
      {fadeLeft && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-7 bg-gradient-to-r from-[#0D1016] to-transparent"
        />
      )}
      {fadeRight && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-[#0D1016] to-transparent"
        />
      )}
    </nav>
  );
}
