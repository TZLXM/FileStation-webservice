import { Component, type ErrorInfo, type ReactNode } from 'react';

interface PageErrorBoundaryProps {
  children: ReactNode;
}

interface PageErrorBoundaryState {
  hasError: boolean;
}

export default class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PageErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('页面渲染失败', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
          <h1 className="text-xl font-semibold">页面暂时无法显示</h1>
          <p className="text-sm text-gray-600">页面加载失败，请刷新后重试。</p>
          <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 bg-blue-600 text-white rounded-md">
            刷新页面
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
