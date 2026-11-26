import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  Layers,
  Palette,
  RotateCcw,
  Ruler,
  SwatchBook,
  Wrench,
} from 'lucide-react';
import {
  FINISH_PRESETS,
  PATTERN_CATALOG,
  SLOT_SPECS,
  WEAPON_THEMES,
} from '../data/catalog';
import {
  DimensionSliderSpec,
  FinishPreset,
  PaintGroup,
  PaintPattern,
  PartPaint,
  ResolvedMechanics,
  SlotId,
  WeaponConfig,
  WeaponDimensions,
} from '../types/weapon';
import { harmonizeAccentColor } from '../utils/weaponLogic';

interface Props {
  config: WeaponConfig;
  mechanics: ResolvedMechanics;
  activeSlot: SlotId;
  onSelectSlot: (slot: SlotId) => void;
  onHoverSlot: (slot: SlotId | null) => void;
  onChangeVariant: (slot: SlotId, variantId: string) => void;
  onChangeDimension: (key: keyof WeaponDimensions, value: number, commitHistory: boolean) => void;
  onApplyDimensionPatch: (patch: Partial<WeaponDimensions>, label?: string) => void;
  onResetDimension: (key: keyof WeaponDimensions) => void;
  onResetSlotDimensions: (slot: SlotId) => void;
  onResetAllDimensions: () => void;
  onChangePaint: (
    slot: SlotId,
    patch: Partial<PartPaint>,
    group: PaintGroup,
    commitHistory: boolean
  ) => void;
  onSyncCurrentPaintToGroup: (slot: SlotId, group: PaintGroup) => void;
  onApplyTheme: (themeId: string) => void;
  onFocusPart: (slot: SlotId) => void;
}

const PAINT_GROUPS: Array<{ id: PaintGroup; label: string }> = [
  { id: 'single', label: 'This Part' },
  { id: 'metal', label: 'Metal' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'attachments', label: 'Attach.' },
  { id: 'all', label: 'Whole Gun' },
];

function formatSliderValue(slider: DimensionSliderSpec, rawVal: number): string {
  const mult = slider.displayMultiplier ?? 1;
  const scaled = rawVal * mult;
  const sign = slider.min < 0 && scaled > 0.05 ? '+' : '';
  if (slider.unit === '×') return `${rawVal.toFixed(2)}×`;
  if (slider.unit === '°') return `${sign}${Math.round(scaled)}°`;
  if (slider.unit === '%') return `${Math.round(scaled)}%`;
  if (slider.unit === 'cm') return `${sign}${scaled.toFixed(1)} cm`;
  return `${sign}${Math.round(scaled)} ${slider.unit}`;
}

export function InspectorPanel({
  config,
  mechanics,
  activeSlot,
  onSelectSlot,
  onHoverSlot,
  onChangeVariant,
  onChangeDimension,
  onApplyDimensionPatch,
  onResetDimension,
  onResetSlotDimensions,
  onResetAllDimensions,
  onChangePaint,
  onSyncCurrentPaintToGroup,
  onApplyTheme,
  onFocusPart,
}: Props) {
  const [activeTab, setActiveTab] = useState<'build' | 'shape' | 'paint'>('build');
  const [paintGroup, setPaintGroup] = useState<PaintGroup>('single');
  const [themesOpen, setThemesOpen] = useState(false);
  const themesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (themesRef.current && !themesRef.current.contains(e.target as Node)) {
        setThemesOpen(false);
      }
    };
    window.addEventListener('mousedown', onOutside);
    return () => window.removeEventListener('mousedown', onOutside);
  }, []);

  const spec = SLOT_SPECS[activeSlot];
  const currentVariantId = (config.parts as unknown as Record<string, string>)[activeSlot];
  const currentVariant = spec.variants.find((v) => v.id === currentVariantId) ?? spec.variants[0];
  const isRemoved = currentVariantId === 'none';
  const currentPaint = config.paints[activeSlot];

  const handleToggleEquip = () => {
    if (!spec.optional) return;
    if (isRemoved) {
      const firstReal = spec.variants.find((v) => v.id !== 'none');
      if (firstReal) onChangeVariant(activeSlot, firstReal.id);
    } else {
      onChangeVariant(activeSlot, 'none');
    }
  };

  const handleFinishChip = (finish: FinishPreset) => {
    const patch: Partial<PartPaint> = {
      metalness: finish.metalness,
      roughness: finish.roughness,
    };
    if (finish.pattern) patch.pattern = finish.pattern;
    if (finish.primaryColor) patch.primaryColor = finish.primaryColor;
    if (finish.secondaryColor) patch.secondaryColor = finish.secondaryColor;
    onChangePaint(activeSlot, patch, paintGroup, true);
  };

  const handlePrimaryColor = (hex: string) => {
    onChangePaint(
      activeSlot,
      {
        primaryColor: hex,
        secondaryColor: harmonizeAccentColor(hex),
      },
      paintGroup,
      true
    );
  };

  const partStatusLabel =
    activeSlot === 'underbarrel' && mechanics.underbarrelDisabledByHandguard
      ? 'Needs Handguard'
      : isRemoved
        ? 'Removed'
        : activeSlot === 'receiver'
          ? mechanics.isBullpup
            ? 'Bullpup Layout'
            : 'Standard Layout'
          : 'Equipped';

  return (
    <aside
      aria-label="Component Inspector"
      className="flex h-full w-full flex-col border-l border-[#1E232D] bg-[#0F1218] text-[#E6E9EE]"
    >
      {/* 1. Active Component Header + Quick Actions + 3-Tab Switch */}
      <div className="shrink-0 border-b border-[#1D222C] px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[#F3F5F8] truncate">{spec.label}</h2>
            <p className="mt-0.5 text-xs text-[#848F9F] truncate">{currentVariant.name}</p>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {spec.optional && (
              <button
                type="button"
                onClick={handleToggleEquip}
                title={isRemoved ? `Equip ${spec.label}` : `Remove ${spec.label}`}
                aria-label={isRemoved ? `Equip ${spec.label}` : `Remove ${spec.label}`}
                className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors whitespace-nowrap ${
                  isRemoved
                    ? 'border-[#272F3E] bg-[#151A24] text-[#9AA5B8] hover:text-[#F3F5F8]'
                    : 'border-[#272F3E] bg-[#151A24] text-[#C8D0DC] hover:border-[#3A4559]'
                }`}
              >
                {isRemoved ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                <span>{isRemoved ? 'Equip' : 'Remove'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => onFocusPart(activeSlot)}
              title={`Focus camera on ${spec.label}`}
              aria-label={`Focus camera on ${spec.label}`}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-[#272F3E] bg-[#151A24] text-[#A5B0C0] hover:border-[#3A4559] hover:text-[#F3F5F8] transition-colors"
            >
              <Crosshair className="h-3.5 w-3.5" />
            </button>

            <div ref={themesRef} className="relative">
              <button
                type="button"
                onClick={() => setThemesOpen((v) => !v)}
                aria-expanded={themesOpen}
                title="Full-weapon paint themes"
                aria-label="Full-weapon paint themes"
                className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                  themesOpen
                    ? 'border-[#F59E0B]/70 bg-[#F59E0B]/15 text-[#FBBF24]'
                    : 'border-[#272F3E] bg-[#151A24] text-[#A5B0C0] hover:border-[#3A4559] hover:text-[#F3F5F8]'
                }`}
              >
                <SwatchBook className="h-3.5 w-3.5" />
              </button>

              {themesOpen && (
                <div className="absolute right-0 z-40 mt-1.5 w-56 rounded-lg border border-[#283040] bg-[#12161F] p-1.5 shadow-2xl">
                  <div className="px-2 py-1 text-[11px] font-medium text-[#848F9F]">
                    Weapon Paint Themes
                  </div>
                  {WEAPON_THEMES.map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      onClick={() => {
                        onApplyTheme(theme.id);
                        setThemesOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs font-medium text-[#DCE2EC] hover:bg-[#1B212E] transition-colors"
                    >
                      <span className="truncate">{theme.name}</span>
                      <span className="flex items-center gap-1 shrink-0" aria-hidden="true">
                        {theme.swatches.map((sw, idx) => (
                          <span
                            key={idx}
                            className="h-3 w-3 rounded-full border border-white/15"
                            style={{ backgroundColor: sw }}
                          />
                        ))}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 3-Tab Segmented Switch: Build | Shape | Smart Paint */}
        <div
          role="tablist"
          aria-label="Inspector mode"
          className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-[#141821] p-1 border border-[#1E2430]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'build'}
            onClick={() => setActiveTab('build')}
            className={`inline-flex h-7 items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap px-1.5 ${
              activeTab === 'build'
                ? 'bg-[#222836] text-[#F8FAFC] shadow-sm'
                : 'text-[#8C96A8] hover:text-[#DCE2EC]'
            }`}
          >
            <Wrench className="h-3.5 w-3.5 shrink-0" />
            <span>Build</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'shape'}
            onClick={() => setActiveTab('shape')}
            className={`inline-flex h-7 items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap px-1.5 ${
              activeTab === 'shape'
                ? 'bg-[#222836] text-[#F8FAFC] shadow-sm'
                : 'text-[#8C96A8] hover:text-[#DCE2EC]'
            }`}
          >
            <Ruler className="h-3.5 w-3.5 shrink-0" />
            <span>Shape</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'paint'}
            onClick={() => setActiveTab('paint')}
            className={`inline-flex h-7 items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap px-1.5 ${
              activeTab === 'paint'
                ? 'bg-[#222836] text-[#F8FAFC] shadow-sm'
                : 'text-[#8C96A8] hover:text-[#DCE2EC]'
            }`}
          >
            <Palette className="h-3.5 w-3.5 shrink-0" />
            <span>Smart Paint</span>
          </button>
        </div>
      </div>

      {/* 3. Scrollable Tab Body */}
      <div className="studio-scroll flex-1 overflow-y-auto px-4 py-3.5">
        {activeTab === 'build' && (
          <div className="space-y-4">
            {/* Mechanical guardrails / compatibility callouts */}
            {activeSlot === 'underbarrel' && mechanics.underbarrelDisabledByHandguard && (
              <div className="rounded-lg border border-[#F59E0B]/35 bg-[#F59E0B]/10 px-3 py-2 text-xs text-[#FCD34D]">
                Underbarrel mounts require a Handguard. Equip a handguard to enable this slot.
              </div>
            )}
            {activeSlot === 'handguard' && mechanics.handguardClamped && (
              <div className="rounded-lg border border-[#2C3545] bg-[#151A24] px-3 py-2 text-xs text-[#A9B4C6]">
                Length auto-clamped to clear barrel muzzle threads (
                {Math.round(mechanics.effectiveHandguardLength * 100)} cm).
              </div>
            )}
            {activeSlot === 'optic' && mechanics.needsAkSideBridge && (
              <div className="rounded-lg border border-[#2C3545] bg-[#151A24] px-3 py-2 text-xs text-[#A9B4C6]">
                AK dovetail side-mount rail bridge automatically fitted to stamped receiver.
              </div>
            )}

            {/* Hardware & Mount Specification Card */}
            <section className="rounded-lg border border-[#1E2430] bg-[#131720] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#7D889B]">Mount Interface</span>
                <span className="text-[11px] font-medium text-[#CBD4E1]">{partStatusLabel}</span>
              </div>
              <div className="mt-1 text-xs font-medium text-[#E8ECF2]">{spec.mountInterface}</div>
              <div className="mt-2 flex items-center justify-between border-t border-[#1D2330] pt-2 text-[11px] text-[#848F9F]">
                <span>Material Group: <strong className="font-medium capitalize text-[#C8D0DC]">{spec.group}</strong></span>
                <button
                  type="button"
                  onClick={() => setActiveTab('shape')}
                  className="inline-flex items-center gap-0.5 font-medium text-[#F59E0B] hover:text-[#FBBF24] transition-colors"
                >
                  <span>Tune shape</span>
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            </section>

            {/* Hardware Variants 2-column Grid */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-medium text-[#98A3B5]">Hardware Variants</h3>
                <span className="text-[11px] text-[#677285] font-mono-tabular">
                  {spec.variants.length} models
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {spec.variants.map((variant) => {
                  const active = variant.id === currentVariantId;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      onClick={() => onChangeVariant(activeSlot, variant.id)}
                      className={`flex flex-col items-start rounded-lg border px-2.5 py-2 text-left transition-colors ${
                        active
                          ? 'border-[#F59E0B]/80 bg-[#1B202C] text-[#F8FAFC]'
                          : 'border-[#1F2531] bg-[#141821] text-[#C8D0DC] hover:border-[#323C4E] hover:bg-[#181D28]'
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-1">
                        <span className="text-xs font-semibold leading-snug truncate">
                          {variant.name}
                        </span>
                        {active && <Check className="h-3 w-3 shrink-0 text-[#F59E0B]" />}
                      </div>
                      <span className="mt-0.5 text-[11px] leading-tight text-[#7D889B] line-clamp-2">
                        {variant.shortDesc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Connected Assembly Quick-Jump */}
            <section className="border-t border-[#1D222C] pt-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-medium text-[#98A3B5]">Connected Assembly</h3>
                <span className="text-[11px] text-[#677285]">Quick jump</span>
              </div>
              <div className="space-y-1.5">
                {spec.relatedSlots.map((relId) => {
                  const relSpec = SLOT_SPECS[relId];
                  const relVarId = (config.parts as unknown as Record<string, string>)[relId];
                  const relVar =
                    relSpec.variants.find((v) => v.id === relVarId) ?? relSpec.variants[0];
                  return (
                    <button
                      key={relId}
                      type="button"
                      onClick={() => onSelectSlot(relId)}
                      onMouseEnter={() => onHoverSlot(relId)}
                      onMouseLeave={() => onHoverSlot(null)}
                      className="flex w-full items-center justify-between rounded-lg border border-[#1E2430] bg-[#141821] px-2.5 py-2 text-left hover:border-[#313B4D] hover:bg-[#181D28] transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[#DCE2EC]">{relSpec.label}</div>
                        <div className="text-[11px] text-[#7D889B] truncate">{relVar.name}</div>
                      </div>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#687385]" />
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'shape' && (
          <div className="space-y-4">
            {/* Mechanical clamp notice on Shape tab too */}
            {activeSlot === 'handguard' && mechanics.handguardClamped && (
              <div className="rounded-lg border border-[#F59E0B]/35 bg-[#F59E0B]/10 px-3 py-2 text-xs text-[#FCD34D]">
                Handguard length clamped at {Math.round(mechanics.effectiveHandguardLength * 100)} cm to clear barrel threads.
              </div>
            )}

            {/* Quick Proportion Profiles (3 per slot) */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-medium text-[#98A3B5]">Proportion Profiles</h3>
                <span className="text-[11px] text-[#677285]">{spec.label}</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {spec.shapePresets.map((preset) => {
                  const isMatch = Object.entries(preset.values).every(([k, target]) => {
                    if (typeof target !== 'number') return true;
                    const curr = config.dimensions[k as keyof WeaponDimensions];
                    return Math.abs(curr - target) < 0.0025;
                  });
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        onApplyDimensionPatch(preset.values, `${spec.label}: ${preset.label}`)
                      }
                      className={`flex flex-col items-start rounded-lg border px-2 py-2 text-left transition-colors ${
                        isMatch
                          ? 'border-[#F59E0B]/80 bg-[#1B202C] text-[#F8FAFC]'
                          : 'border-[#1F2531] bg-[#141821] text-[#C8D0DC] hover:border-[#323C4E] hover:bg-[#181D28]'
                      }`}
                    >
                      <span className="text-[11px] font-semibold leading-tight truncate w-full">
                        {preset.label}
                      </span>
                      <span className="mt-0.5 text-[10px] leading-tight text-[#7D889B] line-clamp-1 w-full">
                        {preset.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Detailed Parametric Sliders */}
            <section className="border-t border-[#1D222C] pt-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-medium text-[#98A3B5]">
                  CAD Dimensions ({spec.sliders.length})
                </h3>
                <button
                  type="button"
                  onClick={() => onResetSlotDimensions(activeSlot)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[#8C97AA] hover:bg-[#1B202C] hover:text-[#F3F5F8] transition-colors"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Reset part</span>
                </button>
              </div>
              <div className="space-y-3.5">
                {spec.sliders.map((slider) => {
                  const val = config.dimensions[slider.key];
                  const displayVal = formatSliderValue(slider, val);
                  const minLabel = formatSliderValue(slider, slider.min);
                  const maxLabel = formatSliderValue(slider, slider.max);
                  const isDefault = Math.abs(val - slider.defaultValue) < 0.0005;

                  return (
                    <div
                      key={slider.key}
                      className="rounded-lg border border-[#1B202B] bg-[#131720] px-2.5 py-2 space-y-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <label
                          htmlFor={`slider-${slider.key}`}
                          className="text-xs font-medium text-[#D6DCE6]"
                        >
                          {slider.label}
                        </label>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-[#F1F5F9] font-mono-tabular">
                            {displayVal}
                          </span>
                          <button
                            type="button"
                            onClick={() => onResetDimension(slider.key)}
                            disabled={isDefault}
                            aria-label={`Reset ${slider.label}`}
                            title={`Reset ${slider.label}`}
                            className={`flex h-5 w-5 items-center justify-center rounded transition-colors ${
                              isDefault
                                ? 'text-[#3C4454] cursor-default'
                                : 'text-[#7A869A] hover:bg-[#1E2432] hover:text-[#E6E9EE]'
                            }`}
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      <input
                        id={`slider-${slider.key}`}
                        type="range"
                        min={slider.min}
                        max={slider.max}
                        step={slider.step}
                        value={val}
                        onChange={(e) =>
                          onChangeDimension(slider.key, parseFloat(e.target.value), false)
                        }
                        onPointerUp={(e) =>
                          onChangeDimension(
                            slider.key,
                            parseFloat((e.target as HTMLInputElement).value),
                            true
                          )
                        }
                        onKeyUp={(e) =>
                          onChangeDimension(
                            slider.key,
                            parseFloat((e.target as HTMLInputElement).value),
                            true
                          )
                        }
                        className="studio-slider"
                      />
                      <div className="flex items-center justify-between text-[10px] text-[#667185] font-mono-tabular">
                        <span>{minLabel}</span>
                        <span>{maxLabel}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Overall Weapon Dimensions Summary */}
            <section className="border-t border-[#1D222C] pt-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-medium text-[#98A3B5]">Weapon Measurements</h3>
                <button
                  type="button"
                  onClick={onResetAllDimensions}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[#8C97AA] hover:bg-[#1B202C] hover:text-[#F3F5F8] transition-colors"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Reset all</span>
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="rounded-md border border-[#1D2330] bg-[#131720] px-2.5 py-1.5">
                  <div className="text-[10px] text-[#758094]">Overall Length</div>
                  <div className="text-xs font-semibold text-[#E8ECF2] font-mono-tabular">
                    {mechanics.estimatedLengthCm} cm
                  </div>
                </div>
                <div className="rounded-md border border-[#1D2330] bg-[#131720] px-2.5 py-1.5">
                  <div className="text-[10px] text-[#758094]">Barrel Bore</div>
                  <div className="text-xs font-semibold text-[#E8ECF2] font-mono-tabular">
                    {(config.dimensions.barrelLength * 100).toFixed(1)} cm · Ø
                    {Math.round(config.dimensions.barrelThickness * 2000)} mm
                  </div>
                </div>
                <div className="rounded-md border border-[#1D2330] bg-[#131720] px-2.5 py-1.5">
                  <div className="text-[10px] text-[#758094]">Effective Forend</div>
                  <div className="text-xs font-semibold text-[#E8ECF2] font-mono-tabular">
                    {config.parts.handguard === 'none'
                      ? 'None'
                      : `${(mechanics.effectiveHandguardLength * 100).toFixed(1)} cm`}
                  </div>
                </div>
                <div className="rounded-md border border-[#1D2330] bg-[#131720] px-2.5 py-1.5">
                  <div className="text-[10px] text-[#758094]">Grip / Optic Rise</div>
                  <div className="text-xs font-semibold text-[#E8ECF2] font-mono-tabular">
                    {Math.round(config.dimensions.gripAngle)}° · +
                    {Math.round(config.dimensions.opticMountHeight * 1000)} mm
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {activeTab === 'paint' && (
          <div className="space-y-5">
            {/* Smart Group Sync */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-medium text-[#98A3B5]">Smart Paint Target</h3>
                {paintGroup !== 'single' && (
                  <button
                    type="button"
                    onClick={() => onSyncCurrentPaintToGroup(activeSlot, paintGroup)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#F59E0B] hover:text-[#FBBF24] transition-colors"
                  >
                    <Layers className="h-3 w-3" />
                    <span>Sync now</span>
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1">
                {PAINT_GROUPS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => {
                      setPaintGroup(g.id);
                      if (g.id !== 'single') {
                        onSyncCurrentPaintToGroup(activeSlot, g.id);
                      }
                    }}
                    className={`rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap ${
                      paintGroup === g.id
                        ? 'border-[#F59E0B]/70 bg-[#F59E0B]/15 text-[#FCD34D]'
                        : 'border-[#1F2531] bg-[#141821] text-[#98A3B5] hover:border-[#323C4E] hover:text-[#E6E9EE]'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Dual-Tone Color Pickers */}
            <section className="border-t border-[#1D222C] pt-4">
              <h3 className="mb-2.5 text-xs font-medium text-[#98A3B5]">Dual-Tone Color</h3>
              <div className="grid grid-cols-2 gap-2.5">
                <label className="flex cursor-pointer items-center justify-between rounded-lg border border-[#222835] bg-[#141821] px-2.5 py-2 hover:border-[#353F52] transition-colors">
                  <div>
                    <div className="text-[11px] font-medium text-[#DCE2EC]">Primary</div>
                    <div className="text-[10px] text-[#7D889B] font-mono-tabular uppercase">
                      {currentPaint.primaryColor}
                    </div>
                  </div>
                  <input
                    type="color"
                    aria-label="Primary color"
                    value={currentPaint.primaryColor}
                    onChange={(e) => handlePrimaryColor(e.target.value)}
                    className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between rounded-lg border border-[#222835] bg-[#141821] px-2.5 py-2 hover:border-[#353F52] transition-colors">
                  <div>
                    <div className="text-[11px] font-medium text-[#DCE2EC]">Accent</div>
                    <div className="text-[10px] text-[#7D889B] font-mono-tabular uppercase">
                      {currentPaint.secondaryColor}
                    </div>
                  </div>
                  <input
                    type="color"
                    aria-label="Accent color"
                    value={currentPaint.secondaryColor}
                    onChange={(e) =>
                      onChangePaint(
                        activeSlot,
                        { secondaryColor: e.target.value },
                        paintGroup,
                        true
                      )
                    }
                    className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </label>
              </div>
            </section>

            {/* Material Finish Chips */}
            <section className="border-t border-[#1D222C] pt-4">
              <h3 className="mb-2 text-xs font-medium text-[#98A3B5]">Material Finishes</h3>
              <div className="flex flex-wrap gap-1.5">
                {FINISH_PRESETS.map((finish) => (
                  <button
                    key={finish.id}
                    type="button"
                    onClick={() => handleFinishChip(finish)}
                    className="rounded-md border border-[#232A37] bg-[#141821] px-2.5 py-1 text-[11px] font-medium text-[#C8D0DC] hover:border-[#F59E0B]/60 hover:text-[#F8FAFC] transition-colors whitespace-nowrap"
                  >
                    {finish.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Procedural PBR Pattern Selector */}
            <section className="border-t border-[#1D222C] pt-4">
              <h3 className="mb-2 text-xs font-medium text-[#98A3B5]">Surface Pattern</h3>
              <div className="grid grid-cols-2 gap-1.5">
                {PATTERN_CATALOG.map((pat) => {
                  const active = currentPaint.pattern === pat.id;
                  return (
                    <button
                      key={pat.id}
                      type="button"
                      onClick={() =>
                        onChangePaint(
                          activeSlot,
                          { pattern: pat.id as PaintPattern },
                          paintGroup,
                          true
                        )
                      }
                      className={`rounded-md border px-2.5 py-1.5 text-left text-xs font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'border-[#F59E0B]/80 bg-[#1B202C] text-[#F8FAFC]'
                          : 'border-[#1F2531] bg-[#141821] text-[#B8C2D1] hover:border-[#323C4E] hover:text-[#F3F5F8]'
                      }`}
                    >
                      {pat.label}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Surface Sliders: Metalness, Roughness, Pattern Scale, Battle Wear */}
            <section className="space-y-3.5 border-t border-[#1D222C] pt-4">
              <h3 className="text-xs font-medium text-[#98A3B5]">Surface Properties</h3>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="paint-metalness" className="text-[#D0D7E2]">
                    Metalness
                  </label>
                  <span className="text-[#98A3B5] font-mono-tabular">
                    {Math.round(currentPaint.metalness * 100)}%
                  </span>
                </div>
                <input
                  id="paint-metalness"
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={currentPaint.metalness}
                  onChange={(e) =>
                    onChangePaint(
                      activeSlot,
                      { metalness: parseFloat(e.target.value) },
                      paintGroup,
                      false
                    )
                  }
                  onPointerUp={(e) =>
                    onChangePaint(
                      activeSlot,
                      { metalness: parseFloat((e.target as HTMLInputElement).value) },
                      paintGroup,
                      true
                    )
                  }
                  className="studio-slider"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="paint-roughness" className="text-[#D0D7E2]">
                    Roughness
                  </label>
                  <span className="text-[#98A3B5] font-mono-tabular">
                    {Math.round(currentPaint.roughness * 100)}%
                  </span>
                </div>
                <input
                  id="paint-roughness"
                  type="range"
                  min={0.06}
                  max={0.98}
                  step={0.02}
                  value={currentPaint.roughness}
                  onChange={(e) =>
                    onChangePaint(
                      activeSlot,
                      { roughness: parseFloat(e.target.value) },
                      paintGroup,
                      false
                    )
                  }
                  onPointerUp={(e) =>
                    onChangePaint(
                      activeSlot,
                      { roughness: parseFloat((e.target as HTMLInputElement).value) },
                      paintGroup,
                      true
                    )
                  }
                  className="studio-slider"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="paint-scale" className="text-[#D0D7E2]">
                    Pattern Scale
                  </label>
                  <span className="text-[#98A3B5] font-mono-tabular">
                    {currentPaint.patternScale.toFixed(1)}×
                  </span>
                </div>
                <input
                  id="paint-scale"
                  type="range"
                  min={0.5}
                  max={3.0}
                  step={0.1}
                  value={currentPaint.patternScale}
                  onChange={(e) =>
                    onChangePaint(
                      activeSlot,
                      { patternScale: parseFloat(e.target.value) },
                      paintGroup,
                      false
                    )
                  }
                  onPointerUp={(e) =>
                    onChangePaint(
                      activeSlot,
                      { patternScale: parseFloat((e.target as HTMLInputElement).value) },
                      paintGroup,
                      true
                    )
                  }
                  className="studio-slider"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="paint-wear" className="text-[#D0D7E2]">
                    Battle Wear
                  </label>
                  <span className="text-[#98A3B5] font-mono-tabular">
                    {Math.round(currentPaint.wear * 100)}%
                  </span>
                </div>
                <input
                  id="paint-wear"
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={currentPaint.wear}
                  onChange={(e) =>
                    onChangePaint(
                      activeSlot,
                      { wear: parseFloat(e.target.value) },
                      paintGroup,
                      false
                    )
                  }
                  onPointerUp={(e) =>
                    onChangePaint(
                      activeSlot,
                      { wear: parseFloat((e.target as HTMLInputElement).value) },
                      paintGroup,
                      true
                    )
                  }
                  className="studio-slider"
                />
              </div>
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}
