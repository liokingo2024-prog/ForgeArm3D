import React from 'react';
import { RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class CanvasErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset?: () => void },
  State
> {
  constructor(props: { children: React.ReactNode; onReset?: () => void }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message || 'WebGL viewport failed to initialize.',
    };
  }

  handleRecover = () => {
    this.setState({ hasError: false, message: '' });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center bg-[#0C0F14] p-8 text-center">
          <p className="text-base font-semibold text-[#E6E9EE]">3D Viewport Unavailable</p>
          <p className="mt-2 max-w-md text-sm text-[#8F99A8]">{this.state.message}</p>
          <button
            type="button"
            onClick={this.handleRecover}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#F59E0B] px-4 py-2 text-xs font-semibold text-[#0B0D10] hover:bg-[#FBBF24] transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reload Viewport
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
