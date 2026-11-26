import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  increment,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import { GodotWeaponCategory, WeaponConfig } from '../types/weapon';
import {
  CloudSavedBuildView,
  CloudUserAccountDoc,
  extractTimestampMs,
  generateBuildId,
  sanitizeAccountCreatePayload,
  sanitizeAccountIdentityPatch,
  sanitizeBuildCreatePayload,
  sanitizeBuildUpdatePatch,
  sortSavedBuildsDesc,
} from '../utils/cloudPayload';

export type AuthModalReason = 'account' | 'export';

interface AuthContextValue {
  user: User | null;
  authReady: boolean;
  isAuthBusy: boolean;
  authError: string | null;
  profile: CloudUserAccountDoc | null;
  savedBuilds: CloudSavedBuildView[];
  isCloudSyncing: boolean;
  authModalOpen: boolean;
  authModalReason: AuthModalReason;
  openAuthModal: (reason?: AuthModalReason) => void;
  closeAuthModal: () => void;
  clearAuthError: () => void;
  requireSignedInForExport: (onAuthorized: () => void) => void;
  signInWithGoogle: () => Promise<User | null>;
  signOutUser: () => Promise<void>;
  saveCloudBuild: (
    config: WeaponConfig,
    category: GodotWeaponCategory,
    lengthCm: number,
    existingBuildId?: string
  ) => Promise<string | null>;
  deleteCloudBuild: (buildId: string) => Promise<void>;
  recordExportActivity: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function formatAuthError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? '');
    if (code === 'auth/popup-closed-by-user') {
      return 'Sign-in was cancelled before finishing.';
    }
    if (code === 'auth/popup-blocked') {
      return 'Sign-in popup was blocked by your browser. Please allow popups for this site and try again.';
    }
    if (code === 'auth/cancelled-popup-request') {
      return 'Previous sign-in request was cancelled. Please try again.';
    }
    if (code === 'auth/unauthorized-domain') {
      return 'This domain is not authorized for Google Sign-In in Firebase Auth settings.';
    }
    if (code === 'auth/network-request-failed') {
      return 'Network error while signing in. Please check your connection.';
    }
  }
  return error instanceof Error ? error.message : 'Unable to complete Google Sign-In.';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [profile, setProfile] = useState<CloudUserAccountDoc | null>(null);
  const [savedBuilds, setSavedBuilds] = useState<CloudSavedBuildView[]>([]);
  const [isCloudSyncing, setIsCloudSyncing] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalReason, setAuthModalReason] = useState<AuthModalReason>('account');

  const pendingExportActionRef = useRef<(() => void) | null>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const ensureProfileInFlightRef = useRef<Map<string, Promise<void>>>(new Map());

  const ensureUserProfileDoc = useCallback(async (currentUser: User): Promise<void> => {
    const existingInFlight = ensureProfileInFlightRef.current.get(currentUser.uid);
    if (existingInFlight) {
      return existingInFlight;
    }

    const path = `users/${currentUser.uid}`;
    const docRef = doc(db, 'users', currentUser.uid);

    const task = (async () => {
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(docRef);
          if (!snap.exists()) {
            const payload = sanitizeAccountCreatePayload({
              uid: currentUser.uid,
              displayName: currentUser.displayName,
              email: currentUser.email,
              photoURL: currentUser.photoURL,
            });
            tx.set(docRef, {
              ...payload,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            return;
          }

          const existing = snap.data() as Partial<CloudUserAccountDoc>;
          const patch = sanitizeAccountIdentityPatch({
            displayName: currentUser.displayName,
            email: currentUser.email,
            photoURL: currentUser.photoURL,
          });
          if (
            existing.displayName !== patch.displayName ||
            existing.email !== patch.email ||
            (patch.photoURL !== undefined && existing.photoURL !== patch.photoURL)
          ) {
            tx.update(docRef, {
              ...patch,
              updatedAt: serverTimestamp(),
            });
          }
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, path);
      } finally {
        ensureProfileInFlightRef.current.delete(currentUser.uid);
      }
    })();

    ensureProfileInFlightRef.current.set(currentUser.uid, task);
    return task;
  }, []);

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setProfile(null);
        setSavedBuilds([]);
      } else {
        void ensureUserProfileDoc(nextUser).catch((err) => {
          console.error('Failed to sync profile document:', err);
        });
      }
    });
    return () => unsubscribe();
  }, [ensureUserProfileDoc]);

  // Real-time listeners guarded strictly by authReady && user
  useEffect(() => {
    if (!authReady || !user) {
      return;
    }

    const userPath = `users/${user.uid}`;
    const unsubProfile = onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => {
        if (snap.exists()) {
          setProfile(snap.data() as CloudUserAccountDoc);
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, userPath);
      }
    );

    const buildsPath = `users/${user.uid}/builds`;
    const buildsQuery = query(
      collection(db, 'users', user.uid, 'builds'),
      where('ownerId', '==', user.uid)
    );
    const unsubBuilds = onSnapshot(
      buildsQuery,
      (snap) => {
        const list: CloudSavedBuildView[] = [];
        snap.forEach((docSnap) => {
          const data = docSnap.data() as CloudSavedBuildView;
          list.push({
            ...data,
            updatedAtMs:
              extractTimestampMs(data.updatedAt) || extractTimestampMs(data.createdAt),
          });
        });
        setSavedBuilds(sortSavedBuildsDesc(list));
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, buildsPath);
      }
    );

    return () => {
      unsubProfile();
      unsubBuilds();
    };
  }, [authReady, user]);

  const openAuthModal = useCallback((reason: AuthModalReason = 'account') => {
    setAuthError(null);
    setAuthModalReason(reason);
    if (reason === 'account') {
      pendingExportActionRef.current = null;
    }
    setAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
    setAuthError(null);
    pendingExportActionRef.current = null;
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const requireSignedInForExport = useCallback((onAuthorized: () => void) => {
    if (userRef.current) {
      onAuthorized();
      return;
    }
    pendingExportActionRef.current = onAuthorized;
    setAuthError(null);
    setAuthModalReason('export');
    setAuthModalOpen(true);
  }, []);

  const signInWithGoogle = useCallback(async (): Promise<User | null> => {
    setIsAuthBusy(true);
    setAuthError(null);
    try {
      const credential = await signInWithPopup(auth, googleProvider);
      await ensureUserProfileDoc(credential.user);
      const pending = pendingExportActionRef.current;
      pendingExportActionRef.current = null;
      if (pending) {
        setAuthModalOpen(false);
        pending();
      }
      return credential.user;
    } catch (err) {
      setAuthError(formatAuthError(err));
      return null;
    } finally {
      setIsAuthBusy(false);
    }
  }, [ensureUserProfileDoc]);

  const signOutUser = useCallback(async (): Promise<void> => {
    setIsAuthBusy(true);
    setAuthError(null);
    try {
      pendingExportActionRef.current = null;
      await signOut(auth);
      setAuthModalOpen(false);
    } catch (err) {
      setAuthError(formatAuthError(err));
    } finally {
      setIsAuthBusy(false);
    }
  }, []);

  const saveCloudBuild = useCallback(
    async (
      config: WeaponConfig,
      category: GodotWeaponCategory,
      lengthCm: number,
      existingBuildId?: string
    ): Promise<string | null> => {
      const currentUser = userRef.current;
      if (!currentUser) {
        openAuthModal('account');
        return null;
      }
      setIsCloudSyncing(true);
      try {
        await ensureUserProfileDoc(currentUser);
        if (existingBuildId) {
          const path = `users/${currentUser.uid}/builds/${existingBuildId}`;
          const patch = sanitizeBuildUpdatePatch({ config, category, lengthCm });
          try {
            await updateDoc(doc(db, 'users', currentUser.uid, 'builds', existingBuildId), {
              ...patch,
              updatedAt: serverTimestamp(),
            });
            return existingBuildId;
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, path);
          }
        } else {
          const buildId = generateBuildId(config.name);
          const path = `users/${currentUser.uid}/builds/${buildId}`;
          const payload = sanitizeBuildCreatePayload({
            buildId,
            ownerId: currentUser.uid,
            config,
            category,
            lengthCm,
          });
          try {
            await setDoc(doc(db, 'users', currentUser.uid, 'builds', buildId), {
              ...payload,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            return buildId;
          } catch (err) {
            handleFirestoreError(err, OperationType.CREATE, path);
          }
        }
      } finally {
        setIsCloudSyncing(false);
      }
    },
    [ensureUserProfileDoc, openAuthModal]
  );

  const deleteCloudBuild = useCallback(async (buildId: string): Promise<void> => {
    const currentUser = userRef.current;
    if (!currentUser) return;
    setIsCloudSyncing(true);
    const path = `users/${currentUser.uid}/builds/${buildId}`;
    try {
      await deleteDoc(doc(db, 'users', currentUser.uid, 'builds', buildId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    } finally {
      setIsCloudSyncing(false);
    }
  }, []);

  const recordExportActivity = useCallback(async (): Promise<void> => {
    const currentUser = userRef.current;
    if (!currentUser) return;
    const path = `users/${currentUser.uid}`;
    try {
      await ensureUserProfileDoc(currentUser);
      await updateDoc(doc(db, 'users', currentUser.uid), {
        exportCount: increment(1),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  }, [ensureUserProfileDoc]);

  return (
    <AuthContext.Provider
      value={{
        user,
        authReady,
        isAuthBusy,
        authError,
        profile,
        savedBuilds,
        isCloudSyncing,
        authModalOpen,
        authModalReason,
        openAuthModal,
        closeAuthModal,
        clearAuthError,
        requireSignedInForExport,
        signInWithGoogle,
        signOutUser,
        saveCloudBuild,
        deleteCloudBuild,
        recordExportActivity,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return ctx;
}
