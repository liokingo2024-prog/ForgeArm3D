import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { AccountModal } from './components/AccountModal';
import { CanvasErrorBoundary } from './components/CanvasErrorBoundary';
import { ComponentBar } from './components/ComponentBar';
import { InspectorPanel } from './components/InspectorPanel';
import { RigOverlayLabels } from './components/RigOverlayLabels';
import { ToastContainer } from './components/ToastContainer';
import { TopBar } from './components/TopBar';
import { CameraViewBar, ViewportToolbar } from './components/ViewportToolbar';
import { useAuth } from './contexts/AuthContext';
import {
  cloneWeaponConfig,
  getInitialWeaponConfig,
  SLOT_ORDER,
  SLOT_SPECS,
} from './data/catalog';
import { WeaponEngine } from './engine/WeaponEngine';
import {
  CameraViewPreset,
  GlbExportQuality,
  HoveredPartInfo,
  HoveredRigBoneInfo,
  PaintGroup,
  PartPaint,
  ProjectedRigNode,
  SlotId,
  StarterPreset,
  ToastMessage,
  ViewportTelemetry,
  WeaponConfig,
  WeaponDimensions,
} from './types/weapon';
import {
  applyDimensionPatch,
  applyPaintToGroup,
  applyWeaponTheme,
  buildGlbExportFilename,
  createHistory,
  formatExportByteSize,
  getGlbExportSpec,
  parseOfflineKeywordPrompt,
  pushHistory,
  redoHistory,
  resetAllDimensions,
  resetSliderDimension,
  resetSlotDimensions,
  resolveMechanicalConstraints,
  sanitizeWeaponConfig,
  undoHistory,
} from './utils/weaponLogic';
import {
  buildGodotBundleFilename,
  buildStoreZip,
  buildWeaponJsonExport,
  computeGodotWeaponCategory,
  generateGodotSceneTscn,
  generateGodotScriptGd,
  slugifyWeaponName,
} from './utils/godotExporter';
import { CloudSavedBuildView } from './utils/cloudPayload';

export default function App() {
  const {
    user,
    profile,
    savedBuilds,
    openAuthModal,
    requireSignedInForExport,
    recordExportActivity,
  } = useAuth();
  const [history, setHistory] = useState(() => createHistory(getInitialWeaponConfig()));
  const [liveConfig, setLiveConfig] = useState<WeaponConfig>(() => history.present);
  const [activeSlot, setActiveSlot] = useState<SlotId>('receiver');
  const [hoveredPart, setHoveredPart] = useState<HoveredPartInfo | null>(null);
  const [hoveredBone, setHoveredBone] = useState<HoveredRigBoneInfo | null>(null);
  const [telemetry, setTelemetry] = useState<ViewportTelemetry>({
    triangles: 0,
    partCount: 8,
    lengthCm: 88,
  });
  const [rigNodes, setRigNodes] = useState<ProjectedRigNode[]>([]);
  const [stockFolded, setStockFolded] = useState(false);
  const [rigOverlay, setRigOverlay] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportQuality, setExportQuality] = useState<GlbExportQuality>('1k');
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [cameraView, setCameraView] = useState<CameraViewPreset>('three_quarter');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [canvasKey, setCanvasKey] = useState(0);

  const canvasMountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WeaponEngine | null>(null);
  const prevGeomSigRef = useRef<string>('');
  const pendingAutoFitRef = useRef<boolean>(false);
  const liveConfigRef = useRef<WeaponConfig>(liveConfig);
  liveConfigRef.current = liveConfig;

  const addToast = useCallback((message: string, tone: ToastMessage['tone'] = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-2), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3400);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const mechanics = useMemo(() => resolveMechanicalConstraints(liveConfig), [liveConfig]);
  const weaponCategory = useMemo(
    () => computeGodotWeaponCategory(liveConfig, mechanics),
    [liveConfig, mechanics]
  );

  // Commit a full config into Undo/Redo history and update live view
  const commitConfig = useCallback((next: WeaponConfig) => {
    setLiveConfig(next);
    setHistory((h) => pushHistory(h, next));
  }, []);

  // Initialize Three.js WeaponEngine ONCE (stable lifecycle, zero canvas teardown on HUD updates)
  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    const engine = new WeaponEngine(container, {
      onSelectSlot: (slot) => {
        setActiveSlot(slot);
      },
      onHoverSlot: (info) => {
        setHoveredPart(info);
      },
      onHoverBone: (info) => {
        setHoveredBone(info);
      },
      onTelemetry: (t) => {
        setTelemetry(t);
      },
      onProjectedRigNodes: (nodes) => {
        setRigNodes(nodes);
      },
    });
    engineRef.current = engine;
    prevGeomSigRef.current = JSON.stringify({
      parts: liveConfigRef.current.parts,
      dimensions: liveConfigRef.current.dimensions,
    });
    engine.rebuildGeometry(liveConfigRef.current);
    engine.setCameraView('three_quarter', true);
    engine.renderImmediate();

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [canvasKey]);

  // Synchronize config changes to Three.js:
  // Geometry rebuild only on parts/dimensions changes; material-only updates mutate in place at 60 FPS
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const geomSig = JSON.stringify({
      parts: liveConfig.parts,
      dimensions: liveConfig.dimensions,
    });
    if (geomSig !== prevGeomSigRef.current) {
      prevGeomSigRef.current = geomSig;
      engine.rebuildGeometry(liveConfig);
      if (pendingAutoFitRef.current) {
        pendingAutoFitRef.current = false;
        engine.setCameraView('three_quarter', false);
      }
    } else {
      engine.updateMaterials(liveConfig);
    }
  }, [liveConfig]);

  // Undo / Redo keyboard shortcuts
  const handleUndo = useCallback(() => {
    setHistory((h) => {
      const next = undoHistory(h);
      if (next !== h) setLiveConfig(next.present);
      return next;
    });
  }, []);

  const handleRedo = useCallback(() => {
    setHistory((h) => {
      const next = redoHistory(h);
      if (next !== h) setLiveConfig(next.present);
      return next;
    });
  }, []);

  const handleSelectSlot = useCallback((slot: SlotId) => {
    setActiveSlot(slot);
    engineRef.current?.setActiveSlot(slot, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const slot = SLOT_ORDER[Number(e.key) - 1];
        if (slot) {
          e.preventDefault();
          handleSelectSlot(slot);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo, handleSelectSlot]);

  const handleHoverUISlot = useCallback((slot: SlotId | null) => {
    engineRef.current?.setHoveredUISlot(slot);
  }, []);

  const handleChangeVariant = useCallback(
    (slot: SlotId, variantId: string) => {
      const next = cloneWeaponConfig(liveConfigRef.current);
      (next.parts as unknown as Record<string, string>)[slot] = variantId;
      // Bullpup auto-pairs cleanly with compact buttpad if stock was standard wood/carbine
      if (slot === 'receiver' && variantId === 'bullpup' && next.parts.stock !== 'none') {
        next.parts.stock = 'bullpup_buttpad';
      } else if (
        slot === 'receiver' &&
        variantId !== 'bullpup' &&
        next.parts.stock === 'bullpup_buttpad'
      ) {
        next.parts.stock = 'tactical_carbine';
      }
      commitConfig(next);
      engineRef.current?.setActiveSlot(slot, true);
    },
    [commitConfig]
  );

  const handleChangeDimension = useCallback(
    (key: keyof WeaponDimensions, value: number, commit: boolean) => {
      const next = cloneWeaponConfig(liveConfigRef.current);
      next.dimensions[key] = value;
      setLiveConfig(next);
      if (commit) {
        setHistory((h) => pushHistory(h, next));
      }
    },
    []
  );

  const handleResetDimension = useCallback(
    (key: keyof WeaponDimensions) => {
      const next = resetSliderDimension(liveConfigRef.current, key);
      commitConfig(next);
    },
    [commitConfig]
  );

  const handleApplyDimensionPatch = useCallback(
    (patch: Partial<WeaponDimensions>, label?: string) => {
      const next = applyDimensionPatch(liveConfigRef.current, patch);
      commitConfig(next);
      if (label) {
        addToast(`Applied ${label} profile`, 'info');
      }
    },
    [commitConfig, addToast]
  );

  const handleResetSlotDimensions = useCallback(
    (slot: SlotId) => {
      const next = resetSlotDimensions(liveConfigRef.current, slot);
      commitConfig(next);
      addToast(`Reset ${SLOT_SPECS[slot].label} proportions`, 'info');
    },
    [commitConfig, addToast]
  );

  const handleResetAllDimensions = useCallback(() => {
    const next = resetAllDimensions(liveConfigRef.current);
    commitConfig(next);
    addToast('Reset all weapon proportions to factory defaults', 'info');
  }, [commitConfig, addToast]);

  const handleSelectCameraView = useCallback((view: CameraViewPreset) => {
    setCameraView(view);
    engineRef.current?.setCameraView(view, false);
  }, []);

  const handleChangePaint = useCallback(
    (slot: SlotId, patch: Partial<PartPaint>, group: PaintGroup, commit: boolean) => {
      const next = applyPaintToGroup(liveConfigRef.current, slot, patch, group);
      setLiveConfig(next);
      if (commit) {
        setHistory((h) => pushHistory(h, next));
      }
    },
    []
  );

  const handleSyncPaintToGroup = useCallback(
    (slot: SlotId, group: PaintGroup) => {
      const next = applyPaintToGroup(liveConfigRef.current, slot, {}, group);
      commitConfig(next);
      addToast(`Synced ${SLOT_SPECS[slot].label} finish to ${group} group`, 'info');
    },
    [commitConfig, addToast]
  );

  const handleApplyTheme = useCallback(
    (themeId: string) => {
      const next = applyWeaponTheme(liveConfigRef.current, themeId);
      commitConfig(next);
      addToast('Applied weapon paint theme', 'success');
    },
    [commitConfig, addToast]
  );

  const handleSelectPreset = useCallback(
    (preset: StarterPreset) => {
      pendingAutoFitRef.current = true;
      setCameraView('three_quarter');
      commitConfig(cloneWeaponConfig(preset.config));
      addToast(`Loaded ${preset.name}`, 'success');
    },
    [commitConfig, addToast]
  );

  const handleSubmitAiPrompt = useCallback(
    async (promptText: string) => {
      setIsAiLoading(true);
      const current = liveConfigRef.current;
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch('/api/ai-gunsmith', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: promptText, currentConfig: current }),
          signal: controller.signal,
        });
        window.clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          const merged = sanitizeWeaponConfig(data.config, current);
          commitConfig(merged);
          addToast(data.summary || 'AI Co-Pilot updated build', 'success');
        } else {
          // Transparent offline keyword fallback when Gemini API is unavailable
          const fallback = parseOfflineKeywordPrompt(promptText, current);
          commitConfig(fallback.config);
          addToast(`Offline Gunsmith: ${fallback.summary}`, 'warning');
        }
      } catch {
        window.clearTimeout(timeoutId);
        const fallback = parseOfflineKeywordPrompt(promptText, current);
        commitConfig(fallback.config);
        addToast(`Offline Gunsmith: ${fallback.summary}`, 'warning');
      } finally {
        setIsAiLoading(false);
      }
    },
    [commitConfig, addToast]
  );

  const executeExportGLB = useCallback(
    async (requestedQuality?: GlbExportQuality) => {
      const engine = engineRef.current;
      if (!engine) return;
      const quality = requestedQuality ?? exportQuality;
      const spec = getGlbExportSpec(quality);
      setIsExporting(true);
      try {
        const { blob } = await engine.exportCleanGLB(quality);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const filename = buildGlbExportFilename(liveConfigRef.current.name, quality);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        void recordExportActivity().catch((err) => {
          console.error('Failed to record export count:', err);
        });
        addToast(
          `Exported ${filename} · ${spec.label} (${spec.textureSize}px · ${formatExportByteSize(blob.size)})`,
          'success'
        );
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'GLB export failed', 'warning');
      } finally {
        setIsExporting(false);
      }
    },
    [addToast, exportQuality, recordExportActivity]
  );

  const handleExportGLB = useCallback(
    (requestedQuality?: GlbExportQuality) => {
      requireSignedInForExport(() => {
        void executeExportGLB(requestedQuality);
      });
    },
    [executeExportGLB, requireSignedInForExport]
  );

  const executeExportGodotScene = useCallback(
    async (requestedQuality?: GlbExportQuality) => {
      const engine = engineRef.current;
      if (!engine) return;
      const quality = requestedQuality ?? exportQuality;
      const spec = getGlbExportSpec(quality);
      setIsExporting(true);
      try {
        const cfg = liveConfigRef.current;
        const solved = resolveMechanicalConstraints(cfg);

        const [{ blob: glbBlob, metadata }, previewPngBytes] = await Promise.all([
          engine.exportCleanGLB(quality),
          engine.renderTransparentThumbnail(640, 360),
        ]);
        const glbBytes = new Uint8Array(await glbBlob.arrayBuffer());

        const weaponId = metadata.weapon_id;
        const glbFilename = `${weaponId}.glb`;
        const jsonFilename = `${weaponId}.json`;
        const tscnFilename = `${weaponId}.tscn`;
        const scriptFilename = `${weaponId}.gd`;

        const jsonExport = buildWeaponJsonExport(cfg, solved, metadata.dimensions_m);
        const tscnText = generateGodotSceneTscn(
          cfg,
          solved,
          glbFilename,
          scriptFilename,
          metadata
        );
        const gdText = generateGodotScriptGd(metadata);
        const jsonText = JSON.stringify(jsonExport, null, 2);

        const encoder = new TextEncoder();
        const zipBytes = buildStoreZip([
          { name: `${weaponId}/${glbFilename}`, data: glbBytes },
          { name: `${weaponId}/${jsonFilename}`, data: encoder.encode(jsonText) },
          { name: `${weaponId}/preview.png`, data: previewPngBytes },
          { name: `${weaponId}/${tscnFilename}`, data: encoder.encode(tscnText) },
          { name: `${weaponId}/${scriptFilename}`, data: encoder.encode(gdText) },
        ]);

        const zipBlob = new Blob([zipBytes], { type: 'application/zip' });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        const bundleFilename = buildGodotBundleFilename(cfg.name, quality);
        a.href = url;
        a.download = bundleFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        void recordExportActivity().catch((err) => {
          console.error('Failed to record export count:', err);
        });

        addToast(
          `Exported ${bundleFilename} · Godot Pack (${spec.label} · ${formatExportByteSize(zipBlob.size)})`,
          'success'
        );
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Godot Pack export failed', 'warning');
      } finally {
        setIsExporting(false);
      }
    },
    [addToast, exportQuality, recordExportActivity]
  );

  const handleExportGodotScene = useCallback(
    (requestedQuality?: GlbExportQuality) => {
      requireSignedInForExport(() => {
        void executeExportGodotScene(requestedQuality);
      });
    },
    [executeExportGodotScene, requireSignedInForExport]
  );

  const executeSaveJSON = useCallback(() => {
    const cfg = liveConfigRef.current;
    const solved = resolveMechanicalConstraints(cfg);
    const measuredDims = engineRef.current?.getMeasuredDimensionsM();
    const payload = buildWeaponJsonExport(cfg, solved, measuredDims);
    const data = JSON.stringify(payload, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = slugifyWeaponName(cfg.name);
    a.href = url;
    a.download = `${slug}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    void recordExportActivity().catch((err) => {
      console.error('Failed to record export count:', err);
    });
    addToast(`Saved ${slug}.json (Godot 4.7.2 metadata & stats)`, 'success');
  }, [addToast, recordExportActivity]);

  const handleSaveJSON = useCallback(() => {
    requireSignedInForExport(() => {
      executeSaveJSON();
    });
  }, [executeSaveJSON, requireSignedInForExport]);

  const handleLoadJSON = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const sanitized = sanitizeWeaponConfig(parsed, liveConfigRef.current);
        commitConfig(sanitized);
        addToast(`Loaded ${file.name}`, 'success');
      } catch {
        addToast('Invalid weapon JSON file', 'warning');
      }
    },
    [commitConfig, addToast]
  );

  const handleLoadCloudBuild = useCallback(
    (build: CloudSavedBuildView) => {
      pendingAutoFitRef.current = true;
      setCameraView('three_quarter');
      const sanitized = sanitizeWeaponConfig(build, liveConfigRef.current);
      commitConfig(sanitized);
      addToast(`Loaded "${sanitized.name}" from Cloud Armory`, 'success');
    },
    [commitConfig, addToast]
  );

  const hoveredLabel = hoveredPart
    ? (() => {
        const sp = SLOT_SPECS[hoveredPart.slot];
        const vId = (liveConfig.parts as unknown as Record<string, string>)[hoveredPart.slot];
        const v = sp.variants.find((item) => item.id === vId);
        return `${sp.label} · ${v?.name ?? vId}`;
      })()
    : null;

  return (
    <div
      data-weapon-name={liveConfig.name}
      data-active-slot={activeSlot}
      className="flex h-screen w-screen flex-col overflow-hidden bg-[#0B0D10] text-[#E6E9EE]"
    >
      <TopBar
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        isAiLoading={isAiLoading}
        isExporting={isExporting}
        isSignedIn={Boolean(user)}
        userDisplayName={profile?.displayName ?? user?.displayName ?? user?.email ?? null}
        userPhotoUrl={profile?.photoURL ?? user?.photoURL ?? null}
        savedBuildsCount={savedBuilds.length}
        exportQuality={exportQuality}
        onChangeExportQuality={setExportQuality}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSubmitPrompt={handleSubmitAiPrompt}
        onSelectPreset={handleSelectPreset}
        onExportGLB={handleExportGLB}
        onExportGodotScene={handleExportGodotScene}
        onSaveJSON={handleSaveJSON}
        onLoadJSON={handleLoadJSON}
        onOpenAccount={() => openAuthModal('account')}
      />

      <main className="relative flex flex-1 min-h-0 flex-col lg:flex-row overflow-hidden">
        {/* Left Primary Column: Ultra-slim Component Bar + Full-Bleed 3D Studio Viewport */}
        <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden">
          <ComponentBar
            config={liveConfig}
            mechanics={mechanics}
            activeSlot={activeSlot}
            onSelectSlot={handleSelectSlot}
            onHoverSlot={handleHoverUISlot}
          />

          <section
            aria-label="3D Weapon Viewport"
            className="relative flex-1 min-h-0 bg-[#0C0F14] overflow-hidden"
          >
          <CanvasErrorBoundary onReset={() => setCanvasKey((k) => k + 1)}>
            <div
              ref={canvasMountRef}
              data-testid="three-viewport"
              className="h-full w-full"
            />
          </CanvasErrorBoundary>

          {/* Subtle top-left active build name & orbit hint */}
          <div className="pointer-events-none absolute left-4 top-3.5 z-10 flex items-center gap-2 text-xs text-[#98A3B5]">
            <span className="font-semibold text-[#E6E9EE]">{liveConfig.name}</span>
            <span className="hidden xl:inline" aria-hidden="true">·</span>
            <span className="hidden xl:inline">Drag orbit · Right-drag pan · Scroll zoom · Click part</span>
          </div>

          {/* Quick Camera Angle Switcher (top-right on desktop, top-left below title on mobile) */}
          <div className="pointer-events-none absolute left-4 top-10 z-20 lg:left-auto lg:right-4 lg:top-3">
            <CameraViewBar activeView={cameraView} onSelectView={handleSelectCameraView} />
          </div>

          {/* Floating 3D Hover Cursor Tooltip */}
          {hoveredPart && hoveredLabel && (
            <div
              style={{
                transform: `translate(${Math.round(hoveredPart.screenX + 14)}px, ${Math.round(
                  hoveredPart.screenY - 12
                )}px)`,
              }}
              className="pointer-events-none absolute left-0 top-0 z-20 rounded-md border border-[#2C3545] bg-[#11151E] px-2.5 py-1 text-[11px] font-medium text-[#EEF2F7] shadow-lg whitespace-nowrap"
            >
              <span>{hoveredLabel}</span>
              <span className="ml-1.5 text-[#8A95A8]">— Click to edit</span>
            </div>
          )}

          {/* Projected 2D Rig Overlay Callouts */}
          {rigOverlay && <RigOverlayLabels nodes={rigNodes} hoveredBone={hoveredBone} />}

          {/* Compact Bottom-Center Viewport Controls */}
          <ViewportToolbar
            telemetry={telemetry}
            stockFolded={stockFolded}
            rigOverlay={rigOverlay}
            wireframe={wireframe}
            onFire={() => engineRef.current?.triggerFire()}
            onReload={() => engineRef.current?.triggerReload()}
            onToggleFoldStock={() => {
              const folded = engineRef.current?.toggleFoldStock() ?? false;
              setStockFolded(folded);
            }}
            onToggleRigOverlay={() => {
              setRigOverlay((prev) => {
                const next = !prev;
                engineRef.current?.setRigOverlay(next);
                return next;
              });
            }}
            onToggleWireframe={() => {
              setWireframe((prev) => {
                const next = !prev;
                engineRef.current?.setWireframe(next);
                return next;
              });
            }}
            onResetCam={() => {
              setCameraView('three_quarter');
              engineRef.current?.resetCamera();
            }}
          />

          {/* Mobile Inspector Drawer Toggle */}
          <button
            type="button"
            onClick={() => setMobileInspectorOpen((v) => !v)}
            aria-expanded={mobileInspectorOpen}
            aria-label={`Toggle ${SLOT_SPECS[activeSlot].label} inspector`}
            className="absolute right-3 top-3 z-20 inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#283040] bg-[#12161F] px-2.5 text-xs font-medium text-[#E6E9EE] lg:hidden whitespace-nowrap"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-[#F59E0B] shrink-0" />
            <span>{SLOT_SPECS[activeSlot].label}</span>
            {mobileInspectorOpen ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5 shrink-0" />
            )}
          </button>
          </section>
        </div>

        {/* Focused Right Inspector Panel (368px desktop, collapsible bottom sheet mobile) */}
        <div
          className={`shrink-0 lg:block lg:h-full lg:w-[368px] ${
            mobileInspectorOpen
              ? 'h-[54vh] w-full border-t border-[#1E232D]'
              : 'hidden'
          }`}
        >
          <InspectorPanel
            config={liveConfig}
            mechanics={mechanics}
            activeSlot={activeSlot}
            onSelectSlot={handleSelectSlot}
            onHoverSlot={handleHoverUISlot}
            onChangeVariant={handleChangeVariant}
            onChangeDimension={handleChangeDimension}
            onApplyDimensionPatch={handleApplyDimensionPatch}
            onResetDimension={handleResetDimension}
            onResetSlotDimensions={handleResetSlotDimensions}
            onResetAllDimensions={handleResetAllDimensions}
            onChangePaint={handleChangePaint}
            onSyncCurrentPaintToGroup={handleSyncPaintToGroup}
            onApplyTheme={handleApplyTheme}
            onFocusPart={(slot) => engineRef.current?.focusOnSlot(slot)}
          />
        </div>
      </main>

      <AccountModal
        currentConfig={liveConfig}
        currentCategory={weaponCategory}
        currentLengthCm={mechanics.estimatedLengthCm}
        onLoadCloudBuild={handleLoadCloudBuild}
        onNotify={addToast}
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
