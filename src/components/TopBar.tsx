import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Download,
  FileJson,
  FolderOpen,
  Loader2,
  Lock,
  LogIn,
  Package,
  Redo2,
  Send,
  Undo2,
} from 'lucide-react';
import { STARTER_PRESETS } from '../data/catalog';
import { GlbExportQuality, StarterPreset } from '../types/weapon';
import { getGlbExportSpec, GLB_EXPORT_QUALITIES } from '../utils/weaponLogic';

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  isAiLoading: boolean;
  isExporting: boolean;
  isSignedIn: boolean;
  userDisplayName: string | null;
  userPhotoUrl: string | null;
  savedBuildsCount: number;
  exportQuality: GlbExportQuality;
  onChangeExportQuality: (quality: GlbExportQuality) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSubmitPrompt: (prompt: string) => void;
  onSelectPreset: (preset: StarterPreset) => void;
  onExportGLB: (quality?: GlbExportQuality) => void;
  onExportGodotScene: (quality?: GlbExportQuality) => void;
  onSaveJSON: () => void;
  onLoadJSON: (file: File) => void;
  onOpenAccount: () => void;
}

export function TopBar({
  canUndo,
  canRedo,
  isAiLoading,
  isExporting,
  isSignedIn,
  userDisplayName,
  userPhotoUrl,
  savedBuildsCount,
  exportQuality,
  onChangeExportQuality,
  onUndo,
  onRedo,
  onSubmitPrompt,
  onSelectPreset,
  onExportGLB,
  onExportGodotScene,
  onSaveJSON,
  onLoadJSON,
  onOpenAccount,
}: Props) {
  const [prompt, setPrompt] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const presetsRef = useRef<HTMLDivElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeExportSpec = getGlbExportSpec(exportQuality);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (presetsRef.current && !presetsRef.current.contains(e.target as Node)) {
        setPresetsOpen(false);
      }
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) {
        setFileMenuOpen(false);
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutside);
    return () => window.removeEventListener('mousedown', handleOutside);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || isAiLoading) return;
    onSubmitPrompt(trimmed);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onLoadJSON(file);
      e.target.value = '';
    }
    setFileMenuOpen(false);
  };

  return (
    <header className="relative z-30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[#1E232D] bg-[#0F1218] px-3 py-2 md:h-14 md:flex-nowrap md:gap-4 md:px-4 md:py-0 shrink-0">
      {/* Left Zone: Brand + History */}
      <div className="flex items-center gap-2.5 shrink-0">
        <span className="text-[15px] font-bold tracking-tight text-[#F3F5F8] whitespace-nowrap">
          ForgeArm <span className="text-[#F59E0B]">3D</span>
        </span>

        <div className="h-4 w-px bg-[#232936]" aria-hidden="true" />

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#A5B0C0] hover:bg-[#1A1F2A] hover:text-[#F3F5F8] disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            aria-label="Redo"
            title="Redo (Ctrl+Y)"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#A5B0C0] hover:bg-[#1A1F2A] hover:text-[#F3F5F8] disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
          >
            <Redo2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Center Zone: AI Co-Pilot Prompt + Starter Presets (drops cleanly below on mobile) */}
      <div className="order-last flex w-full items-center gap-2 min-w-0 md:order-none md:w-auto md:flex-1 md:max-w-2xl">
        <form onSubmit={handleSubmit} className="relative flex flex-1 items-center min-w-0">
          <label htmlFor="ai-gunsmith-input" className="sr-only">
            AI Gunsmith prompt
          </label>
          <input
            id="ai-gunsmith-input"
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder='Try "short suppressed AK with worn walnut" or "add a drum mag"'
            disabled={isAiLoading}
            className="h-9 w-full rounded-lg border border-[#242B38] bg-[#141821] pl-3 pr-10 text-xs text-[#E6E9EE] placeholder-[#6B7688] focus:border-[#F59E0B]/70 focus:outline-none transition-colors"
          />
          <button
            type="submit"
            disabled={isAiLoading || !prompt.trim()}
            aria-label="Apply AI Gunsmith prompt"
            className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-[#202634] text-[#E6E9EE] hover:bg-[#F59E0B] hover:text-[#0B0D10] disabled:opacity-35 disabled:hover:bg-[#202634] disabled:hover:text-[#E6E9EE] transition-colors"
          >
            {isAiLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </button>
        </form>

        {/* Starter Presets Dropdown */}
        <div ref={presetsRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setPresetsOpen((v) => !v)}
            aria-expanded={presetsOpen}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#242B38] bg-[#141821] px-2.5 text-xs font-medium text-[#C8D0DC] hover:border-[#343E50] hover:text-[#F3F5F8] transition-colors whitespace-nowrap"
          >
            <span>Presets</span>
            <ChevronDown className="h-3.5 w-3.5 text-[#7E899B]" />
          </button>

          {presetsOpen && (
            <div className="absolute right-0 z-50 mt-1.5 w-60 rounded-lg border border-[#262D3B] bg-[#12161F] p-1.5 shadow-xl">
              {STARTER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    onSelectPreset(preset);
                    setPresetsOpen(false);
                  }}
                  className="flex w-full flex-col items-start rounded-md px-2.5 py-2 text-left hover:bg-[#1B212E] transition-colors"
                >
                  <span className="text-xs font-semibold text-[#EDF0F5]">{preset.name}</span>
                  <span className="text-[11px] text-[#848F9F]">{preset.subtitle}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Zone: File Menu + Primary Export GLB CTA + Account */}
      <div className="flex items-center gap-2 shrink-0">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileChange}
          className="hidden"
          aria-label="Load JSON file"
        />

        <div ref={fileMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setFileMenuOpen((v) => !v)}
            aria-expanded={fileMenuOpen}
            aria-label="Save or load build JSON"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#242B38] bg-[#141821] px-2.5 text-xs font-medium text-[#C8D0DC] hover:border-[#343E50] hover:text-[#F3F5F8] transition-colors whitespace-nowrap"
          >
            <FileJson className="h-3.5 w-3.5 text-[#8A94A6]" />
            <span className="hidden sm:inline">JSON</span>
          </button>

          {fileMenuOpen && (
            <div className="absolute right-0 mt-1.5 w-44 rounded-lg border border-[#262D3B] bg-[#12161F] p-1 shadow-xl">
              <button
                type="button"
                title={
                  isSignedIn
                    ? 'Includes build config and computed Godot 4 FPS stats'
                    : 'Sign in with Google to export JSON'
                }
                onClick={() => {
                  onSaveJSON();
                  setFileMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[#DCE1EA] hover:bg-[#1B212E] transition-colors"
              >
                <Download className="h-3.5 w-3.5 text-[#8A94A6] shrink-0" />
                <span className="flex-1">Save JSON</span>
                {!isSignedIn && (
                  <Lock className="h-3 w-3 text-[#F59E0B] shrink-0" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[#DCE1EA] hover:bg-[#1B212E] transition-colors"
              >
                <FolderOpen className="h-3.5 w-3.5 text-[#8A94A6] shrink-0" />
                <span>Load JSON</span>
              </button>
            </div>
          )}
        </div>

        <div ref={exportMenuRef} className="relative flex items-center shrink-0">
          <div className="inline-flex h-9 items-stretch overflow-hidden rounded-lg bg-[#F59E0B] text-[#0B0D10] shadow-sm">
            <button
              type="button"
              onClick={() => {
                setExportMenuOpen(false);
                onExportGLB(exportQuality);
              }}
              disabled={isExporting}
              title={
                isSignedIn
                  ? 'Export Godot-ready .GLB'
                  : 'Sign in with Google to export .GLB'
              }
              className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 text-xs font-semibold hover:bg-[#FBBF24] disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              {isExporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : isSignedIn ? (
                <Download className="h-3.5 w-3.5" />
              ) : (
                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{isExporting ? `Exporting ${activeExportSpec.label}…` : 'Export .GLB'}</span>
              {!isExporting && (
                <span className="hidden sm:inline rounded bg-[#0B0D10]/15 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-tight">
                  {activeExportSpec.label}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={isExporting}
              aria-expanded={exportMenuOpen}
              aria-label="GLB export quality options"
              title="Choose GLB texture quality (500, 1K, 2K, 4K)"
              className="inline-flex items-center justify-center border-l border-[#0B0D10]/20 px-2 hover:bg-[#FBBF24] disabled:opacity-60 transition-colors"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>

          {exportMenuOpen && (
            <div
              role="menu"
              aria-label="GLB Export Quality"
              className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-lg border border-[#262D3B] bg-[#12161F] p-1.5 shadow-2xl"
            >
              <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[#7E899B]">
                GLB Texture Quality
              </div>
              <div className="flex flex-col gap-0.5">
                {GLB_EXPORT_QUALITIES.map((opt) => {
                  const selected = opt.id === exportQuality;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => onChangeExportQuality(opt.id)}
                      className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition-colors ${
                        selected
                          ? 'bg-[#1D2433] text-[#F3F5F8]'
                          : 'text-[#C8D0DC] hover:bg-[#181E2B]'
                      }`}
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-[#F3F5F8]">
                            {opt.label}
                          </span>
                          <span className="text-[11px] text-[#8A94A6]">{opt.resolutionText}</span>
                        </div>
                        <span className="text-[10px] text-[#6F7B8E]">{opt.tierHint}</span>
                      </div>
                      {selected && <Check className="h-3.5 w-3.5 text-[#F59E0B] shrink-0" />}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1.5 flex flex-col gap-1.5 border-t border-[#222836] pt-1.5">
                {!isSignedIn && (
                  <div className="flex items-center gap-1.5 rounded-md bg-[#171D2A] px-2.5 py-1.5 text-[10px] text-[#B8C2D1]">
                    <Lock className="h-3 w-3 text-[#F59E0B] shrink-0" />
                    <span>Sign in required to export files</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen(false);
                    onExportGLB(exportQuality);
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#F59E0B] px-3 py-1.5 text-xs font-semibold text-[#0B0D10] hover:bg-[#FBBF24] transition-colors"
                >
                  {isSignedIn ? (
                    <Download className="h-3.5 w-3.5" />
                  ) : (
                    <Lock className="h-3.5 w-3.5" />
                  )}
                  <span>Download .GLB ({activeExportSpec.label})</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen(false);
                    onExportGodotScene(exportQuality);
                  }}
                  className="flex w-full flex-col items-center rounded-md border border-[#2B3446] bg-[#181E2B] px-2.5 py-1.5 text-center hover:border-[#F59E0B]/60 hover:bg-[#1E2636] transition-colors"
                >
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#EDF0F5]">
                    {isSignedIn ? (
                      <Package className="h-3.5 w-3.5 text-[#F59E0B]" />
                    ) : (
                      <Lock className="h-3.5 w-3.5 text-[#F59E0B]" />
                    )}
                    <span>Export .zip (Godot Pack)</span>
                  </span>
                  <span className="text-[10px] text-[#7E899B]">
                    .glb + .json + preview.png + .tscn/.gd
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Account / Sign-in Control */}
        {isSignedIn ? (
          <button
            type="button"
            onClick={onOpenAccount}
            aria-label="Open account and Cloud Armory"
            title="Account & Cloud Armory"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#2A3344] bg-[#141821] px-2 text-xs font-medium text-[#E6E9EE] hover:border-[#F59E0B]/60 transition-colors whitespace-nowrap"
          >
            {userPhotoUrl ? (
              <img
                src={userPhotoUrl}
                alt={userDisplayName ?? 'Account'}
                referrerPolicy="no-referrer"
                className="h-5 w-5 rounded-full object-cover shrink-0"
              />
            ) : (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#F59E0B] text-[10px] font-bold text-[#0B0D10] shrink-0">
                {(userDisplayName ?? 'U').slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="hidden md:inline max-w-[96px] truncate">
              {userDisplayName?.split(' ')[0] || 'Account'}
            </span>
            {savedBuildsCount > 0 && (
              <span className="rounded bg-[#1F2736] px-1.5 py-0.5 font-mono text-[10px] text-[#F59E0B]">
                {savedBuildsCount}
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenAccount}
            aria-label="Sign in with Google"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#242B38] bg-[#141821] px-2.5 text-xs font-medium text-[#DCE1EA] hover:border-[#F59E0B]/60 hover:text-[#F3F5F8] transition-colors whitespace-nowrap"
          >
            <LogIn className="h-3.5 w-3.5 text-[#F59E0B] shrink-0" />
            <span>Sign in</span>
          </button>
        )}
      </div>
    </header>
  );
}
