// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PageErrorBoundary from '../components/PageErrorBoundary';

function BrokenPage(): never {
  throw new Error('render failed');
}

describe('PageErrorBoundary', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('replaces a page render failure with an accessible fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <PageErrorBoundary>
        <BrokenPage />
      </PageErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('页面加载失败，请刷新后重试。');
  });
});
