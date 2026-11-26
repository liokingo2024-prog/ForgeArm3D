import {
  Camera,
  Crosshair,
  Flame,
  FoldHorizontal,
  Grid,
  RefreshCw,
  Target,
} from 'lucide-react';
import { CameraViewPreset, ViewportTelemetry } from '../types/weapon';

const CAMERA_VIEWS: Array<{ id: CameraViewPreset; label: string; title: string }> = [
  { id: 'three_quarter', label: '3/4', title: 'Standard 3/4 studio view' },
  { id: 'right', label: 'Right', title: 'Right side elevation profile' },
  { id: 'left', label: 'Left', title: 'Left side elevation profile' },
  { id: 'top', label: 'Top', title: 'Top-down rail & alignment view' },
  { id: 'ads', label: 'ADS', title: 'Aim-down-sights rear optic alignment view' },
];

interface CameraBarProps {
  activeView: CameraViewPreset;
  onSelectView: (view: CameraViewPreset) => void;
}

export function CameraViewBar({ activeView, onSelectView }: CameraBarProps) {
  return (
    <div
      role="group"
      aria-label="Camera angle presets"
      className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-[#232A37] bg-[#11151D] p-1 shadow-lg"
    >
      <span className="hidden items-center px-1.5 text-[#6D788A] sm:inline-flex" aria-hidden="true">
        <Camera className="h-3.5 w-3.5" />
      </span>
      {CAMERA_VIEWS.map((view) => {
        const active = view.id === activeView;
        return (
          <button
            key={view.id}
            type="button"
            title={view.title}
            aria-pressed={active}
            onClick={() => onSelectView(view.id)}
            className={`h-6 rounded px-2 text-[11px] font-medium transition-colors whitespace-nowrap ${
              active
                ? 'bg-[#F59E0B]/18 text-[#FBBF24] border border-[#F59E0B]/45'
                : 'border border-transparent text-[#A8B2C2] hover:bg-[#1E2430] hover:text-[#F3F5F8]'
            }`}
          >
            {view.label}
          </button>
        );
      })}
    </div>
  );
}

interface Props {
  telemetry: ViewportTelemetry;
  stockFolded: boolean;
  rigOverlay: boolean;
  wireframe: boolean;
  onFire: () => void;
  onReload: () => void;
  onToggleFoldStock: () => void;
  onToggleRigOverlay: () => void;
  onToggleWireframe: () => void;
  onResetCam: () => void;
}

export function ViewportToolbar({
  telemetry,
  stockFolded,
  rigOverlay,
  wireframe,
  onFire,
  onReload,
  onToggleFoldStock,
  onToggleRigOverlay,
  onToggleWireframe,
  onResetCam,
}: Props) {
  const btnBase =
    'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0';
  const btnIdle = 'text-[#C2CBD8] hover:bg-[#1E2430] hover:text-[#F3F5F8]';
  const btnActive = 'bg-[#F59E0B]/15 text-[#FBBF24] border border-[#F59E0B]/40';

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 max-w-[96%]">
      <div className="pointer-events-auto flex items-center gap-1 overflow-x-auto rounded-xl border border-[#232A37] bg-[#11151D] p-1.5 shadow-xl">
        <button type="button" onClick={onFire} className={`${btnBase} ${btnIdle}`}>
          <Flame className="h-3.5 w-3.5 text-[#F59E0B]" />
          <span>Fire</span>
        </button>

        <button type="button" onClick={onReload} className={`${btnBase} ${btnIdle}`}>
          <RefreshCw className="h-3.5 w-3.5 text-[#9AA5B8]" />
          <span>Reload</span>
        </button>

        <button
          type="button"
          onClick={onToggleFoldStock}
          aria-pressed={stockFolded}
          className={`${btnBase} ${stockFolded ? btnActive : btnIdle}`}
        >
          <FoldHorizontal className="h-3.5 w-3.5" />
          <span>Fold Stock</span>
        </button>

        <div className="mx-1 h-4 w-px bg-[#242B38] shrink-0" aria-hidden="true" />

        <button
          type="button"
          onClick={onToggleRigOverlay}
          aria-pressed={rigOverlay}
          title="Preview color-coded 3D socket gizmos & local axes before export"
          className={`${btnBase} ${rigOverlay ? btnActive : btnIdle}`}
        >
          <Target className="h-3.5 w-3.5" />
          <span>Show Sockets</span>
        </button>

        <button
          type="button"
          onClick={onToggleWireframe}
          aria-pressed={wireframe}
          className={`${btnBase} ${wireframe ? btnActive : btnIdle}`}
        >
          <Grid className="h-3.5 w-3.5" />
          <span>Wire</span>
        </button>

        <button
          type="button"
          onClick={onResetCam}
          title="Fit entire weapon in view"
          className={`${btnBase} ${btnIdle}`}
        >
          <Crosshair className="h-3.5 w-3.5 text-[#9AA5B8]" />
          <span>Fit View</span>
        </button>

        <div className="mx-1 hidden h-4 w-px bg-[#242B38] md:block shrink-0" aria-hidden="true" />

        <div
          data-testid="viewport-telemetry"
          className="hidden items-center gap-2 px-2 text-[11px] text-[#7E899B] font-mono-tabular md:flex whitespace-nowrap shrink-0"
        >
          <span>{telemetry.triangles.toLocaleString()} tris</span>
          <span aria-hidden="true">·</span>
          <span>{telemetry.partCount} parts</span>
          <span aria-hidden="true">·</span>
          <span>{telemetry.lengthCm} cm</span>
        </div>
      </div>
    </div>
  );
}
