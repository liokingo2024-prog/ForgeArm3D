import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = {
    hasError: false,
    message: '',
  };

  static getDerivedStateFromError(error: Error): State {
    let display = error.message || 'An unexpected error occurred.';
    try {
      const parsed = JSON.parse(display);
      if (parsed && typeof parsed.error === 'string') {
        display = parsed.error;
      }
    } catch {
      // keep raw message
    }
    return {
      hasError: true,
      message: display,
    };
  }

  componentDidCatch(error: Error) {
    console.error('ForgeArm 3D runtime error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-[#0B0D10] p-6 text-[#E6E9EE]">
          <div className="max-w-md rounded-xl border border-[#283040] bg-[#12161F] p-6 shadow-2xl">
            <div className="mb-3 flex items-center gap-2.5 text-[#F59E0B]">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <h1 className="text-sm font-semibold text-[#F3F5F8]">
                Something went wrong
              </h1>
            </div>
            <p className="mb-5 text-xs leading-relaxed text-[#9AA5B6]">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 rounded-lg bg-[#F59E0B] px-3.5 py-2 text-xs font-semibold text-[#0B0D10] hover:bg-[#FBBF24] transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reload ForgeArm 3D
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
