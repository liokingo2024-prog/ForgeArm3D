import { useEffect } from 'react';
import {
  Cloud,
  Download,
  FolderDown,
  Loader2,
  Lock,
  LogOut,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { GodotWeaponCategory, WeaponConfig } from '../types/weapon';
import { CloudSavedBuildView } from '../utils/cloudPayload';

interface Props {
  currentConfig: WeaponConfig;
  currentCategory: GodotWeaponCategory;
  currentLengthCm: number;
  onLoadCloudBuild: (build: CloudSavedBuildView) => void;
  onNotify: (message: string, tone?: 'info' | 'success' | 'warning') => void;
}

function GoogleGlyph() {
  return (
    <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.4c-.24 1.26-.96 2.33-2.04 3.04l3.3 2.56c1.92-1.77 3.03-4.38 3.03-7.47 0-.72-.06-1.41-.19-2.08H12Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.75 0 5.06-.91 6.75-2.46l-3.3-2.56c-.91.61-2.08.97-3.45.97-2.65 0-4.9-1.79-5.7-4.2H2.89v2.64A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.3 13.75A5.98 5.98 0 0 1 5.98 12c0-.61.11-1.2.32-1.75V7.61H2.89A10 10 0 0 0 2 12c0 1.61.39 3.13 1.09 4.39l3.21-2.64Z"
      />
      <path
        fill="#4285F4"
        d="M12 6.05c1.5 0 2.84.52 3.9 1.53l2.92-2.92C17.05 3.02 14.74 2 12 2a10 10 0 0 0-9.11 5.61l3.41 2.64c.8-2.41 3.05-4.2 5.7-4.2Z"
      />
    </svg>
  );
}

export function AccountModal({
  currentConfig,
  currentCategory,
  currentLengthCm,
  onLoadCloudBuild,
  onNotify,
}: Props) {
  const {
    user,
    isAuthBusy,
    authError,
    profile,
    savedBuilds,
    isCloudSyncing,
    authModalOpen,
    authModalReason,
    closeAuthModal,
    signInWithGoogle,
    signOutUser,
    saveCloudBuild,
    deleteCloudBuild,
  } = useAuth();

  useEffect(() => {
    if (!authModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAuthModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authModalOpen, closeAuthModal]);

  if (!authModalOpen) return null;

  const displayName =
    profile?.displayName || user?.displayName || user?.email?.split('@')[0] || 'Creator';
  const email = profile?.email || user?.email || '';
  const photoURL = profile?.photoURL || user?.photoURL || '';
  const exportCount = profile?.exportCount ?? 0;

  const handleSaveNewBuild = async () => {
    const id = await saveCloudBuild(currentConfig, currentCategory, currentLengthCm);
    if (id) {
      onNotify(`Saved "${currentConfig.name}" to your Cloud Armory`, 'success');
    }
  };

  const handleOverwriteBuild = async (build: CloudSavedBuildView) => {
    const id = await saveCloudBuild(
      currentConfig,
      currentCategory,
      currentLengthCm,
      build.id
    );
    if (id) {
      onNotify(`Updated "${currentConfig.name}" in Cloud Armory`, 'success');
    }
  };

  const handleDeleteBuild = async (build: CloudSavedBuildView) => {
    await deleteCloudBuild(build.id);
    onNotify(`Removed "${build.name}" from Cloud Armory`, 'info');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#06080B]/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeAuthModal();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-modal-title"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[#262E3D] bg-[#11151E] text-[#E6E9EE] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#1E2431] bg-[#0E121A] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            {!user ? (
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#F59E0B]/15 text-[#F59E0B]">
                <Lock className="h-3.5 w-3.5" />
              </div>
            ) : (
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#F59E0B]/15 text-[#F59E0B]">
                <Cloud className="h-3.5 w-3.5" />
              </div>
            )}
            <h2 id="account-modal-title" className="text-sm font-semibold text-[#F3F5F8]">
              {!user
                ? authModalReason === 'export'
                  ? 'Sign in to Export'
                  : 'Sign in to ForgeArm 3D'
                : 'Account & Cloud Armory'}
            </h2>
          </div>

          <button
            type="button"
            onClick={closeAuthModal}
            aria-label="Close modal"
            className="flex h-7 w-7 items-center justify-center rounded-md text-[#8A94A6] hover:bg-[#1B2230] hover:text-[#F3F5F8] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        {!user ? (
          <div className="space-y-4 p-5">
            <p className="text-xs leading-relaxed text-[#B2BCCB]">
              {authModalReason === 'export'
                ? 'Exporting .GLB models, Godot Pack .zip bundles, and .JSON weapon data requires a free ForgeArm account. Everything else in the gunsmith stays unlocked without signing in.'
                : 'Sign in with Google to unlock .GLB, Godot Pack .zip, and .JSON exports, plus personal Cloud Armory storage for your custom weapon builds.'}
            </p>

            <div className="rounded-lg border border-[#202735] bg-[#151A25] px-3.5 py-2.5 text-[11px] text-[#94A0B3]">
              <span className="font-semibold text-[#DCE1EA]">Free without sign-in:</span>{' '}
              All 9 part slots, shape sliders, PBR paints, AI Gunsmith, Fire/Reload previews,
              Rig/Socket overlay, and Load JSON.
            </div>

            {authError && (
              <div
                role="alert"
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200"
              >
                {authError}
              </div>
            )}

            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              disabled={isAuthBusy}
              className="flex h-10 w-full items-center justify-center gap-2.5 rounded-lg bg-[#F59E0B] px-4 text-xs font-semibold text-[#0B0D10] hover:bg-[#FBBF24] disabled:opacity-60 transition-colors"
            >
              {isAuthBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GoogleGlyph />
              )}
              <span>
                {isAuthBusy
                  ? 'Connecting Google Account…'
                  : authModalReason === 'export'
                    ? 'Sign in with Google to Export'
                    : 'Continue with Google'}
              </span>
            </button>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            {/* Signed-in identity row */}
            <div className="flex items-center justify-between gap-3 rounded-lg border border-[#222938] bg-[#151A25] p-3">
              <div className="flex items-center gap-3 min-w-0">
                {photoURL ? (
                  <img
                    src={photoURL}
                    alt={displayName}
                    referrerPolicy="no-referrer"
                    className="h-9 w-9 rounded-full border border-[#2E384B] object-cover shrink-0"
                  />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F59E0B] text-xs font-bold text-[#0B0D10] shrink-0">
                    {displayName.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-[#F3F5F8]">
                    {displayName}
                  </div>
                  <div className="truncate text-[11px] text-[#8A94A6]">{email}</div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <div
                  title="Total verified exports"
                  className="inline-flex items-center gap-1 rounded-md border border-[#273042] bg-[#10141D] px-2 py-1 font-mono text-[11px] text-[#C8D0DC]"
                >
                  <Download className="h-3 w-3 text-[#F59E0B]" />
                  <span>{exportCount}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void signOutUser()}
                  disabled={isAuthBusy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#2A3344] bg-[#12161F] px-2.5 text-[11px] font-medium text-[#C8D0DC] hover:border-[#3D4A61] hover:text-[#F3F5F8] transition-colors"
                >
                  <LogOut className="h-3 w-3" />
                  <span>Sign out</span>
                </button>
              </div>
            </div>

            {authError && (
              <div
                role="alert"
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200"
              >
                {authError}
              </div>
            )}

            {/* Save active build */}
            <div className="flex items-center justify-between gap-3 rounded-lg border border-[#222938] bg-[#141821] px-3.5 py-2.5">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[#7E899B]">
                  Active Workbench Build
                </div>
                <div className="truncate text-xs font-medium text-[#E6E9EE]">
                  {currentConfig.name}{' '}
                  <span className="text-[#7E899B]">· {Math.round(currentLengthCm)} cm</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleSaveNewBuild()}
                disabled={isCloudSyncing}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[#F59E0B] px-3 text-xs font-semibold text-[#0B0D10] hover:bg-[#FBBF24] disabled:opacity-60 transition-colors"
              >
                {isCloudSyncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                <span>Save to Cloud</span>
              </button>
            </div>

            {/* Saved Cloud Armory builds */}
            <div>
              <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[#8A94A6]">
                <span>Cloud Armory ({savedBuilds.length})</span>
                <span className="font-normal normal-case text-[#6E788A]">
                  Synced to your account
                </span>
              </div>

              {savedBuilds.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#262E3D] bg-[#0E121A] px-4 py-6 text-center text-xs text-[#7E899B]">
                  No builds saved yet. Click <span className="text-[#E6E9EE]">Save to Cloud</span>{' '}
                  to store your current weapon configuration.
                </div>
              ) : (
                <div className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
                  {savedBuilds.map((build) => (
                    <div
                      key={build.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-[#222938] bg-[#151A25] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-[#EDF0F5]">
                          {build.name}
                        </div>
                        <div className="text-[11px] text-[#848F9F]">
                          {build.category.replace('_', ' ')} · {build.lengthCm} cm
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            onLoadCloudBuild(build);
                            closeAuthModal();
                          }}
                          title="Load build into 3D studio"
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#2D3648] bg-[#1B2230] px-2 text-[11px] font-medium text-[#E6E9EE] hover:border-[#F59E0B]/60 hover:text-[#F59E0B] transition-colors"
                        >
                          <FolderDown className="h-3 w-3" />
                          <span>Load</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleOverwriteBuild(build)}
                          disabled={isCloudSyncing}
                          title="Overwrite with current workbench build"
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-[#262E3E] bg-[#12161F] text-[#9AA5B6] hover:border-[#3A465C] hover:text-[#F3F5F8] transition-colors"
                        >
                          <RefreshCw className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteBuild(build)}
                          disabled={isCloudSyncing}
                          title="Delete saved build"
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-[#262E3E] bg-[#12161F] text-[#9AA5B6] hover:border-red-500/50 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
