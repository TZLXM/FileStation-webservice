import { useEffect, useRef, useState } from 'react';
import { AuditLogEntry, PaginatedResponse } from '@filestation/shared';
import AppLayout from '../components/AppLayout';
import { api } from '../lib/api';

const PAGE_SIZE = 20;

export default function AuditPage() {
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);

  useEffect(() => {
    const requestId = ++requestVersion.current;
    const action = actionFilter.trim();
    const query = action ? `&action=${encodeURIComponent(action)}` : '';
    setLoading(true);
    setError('');

    api.get<PaginatedResponse<AuditLogEntry>>(`/audit-logs?page=${page}&page_size=${PAGE_SIZE}${query}`)
      .then((response) => {
        if (requestId !== requestVersion.current) return;
        const data = response.data;
        const nextTotal = data?.total ?? 0;
        const nextTotalPages = data?.total_pages ?? Math.ceil(nextTotal / PAGE_SIZE);
        const lastPage = Math.max(nextTotalPages, 1);
        setTotal(nextTotal);
        setTotalPages(nextTotalPages);
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setItems(Array.isArray(data?.items) ? data.items : []);
      })
      .catch((requestError: unknown) => {
        if (requestId !== requestVersion.current) return;
        setItems([]);
        setTotal(0);
        setTotalPages(0);
        setError(requestError instanceof Error && requestError.message ? requestError.message : '加载审计日志失败');
      })
      .finally(() => {
        if (requestId === requestVersion.current) setLoading(false);
      });

    return () => {
      requestVersion.current += 1;
    };
  }, [page, actionFilter]);

  const formatDetails = (details: AuditLogEntry['details']) => details ? JSON.stringify(details, null, 2) : '';

  return (
    <AppLayout>
      <main className="flex-1 p-4 md:p-6 max-w-6xl mx-auto w-full min-w-0">
        <h1 className="text-xl font-bold mb-4">审计日志</h1>
        <div className="mb-4">
          <label className="block text-sm text-gray-700">
            <span className="sr-only">按操作过滤</span>
            <input
              aria-label="按操作过滤"
              value={actionFilter}
              onChange={(event) => { setActionFilter(event.target.value); setPage(1); }}
              placeholder="按操作过滤，如 mcp.tool_called"
              className="px-3 py-2 border border-gray-300 rounded-md text-sm w-full md:w-72"
            />
          </label>
        </div>

        {loading && <p role="status" className="mb-3 text-sm text-gray-600">正在加载审计日志...</p>}
        {error && <p role="alert" className="mb-3 text-sm text-red-600 break-words">加载失败：{error}</p>}

        <div data-testid="audit-table-scroll" className="min-w-0 bg-white shadow rounded-lg overflow-x-auto">
          <table className="min-w-[720px] w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-600">时间</th>
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-600">操作</th>
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-600">资源</th>
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-600">IP</th>
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-600">详情</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((entry) => {
                const details = formatDetails(entry.details);
                return (
                  <tr key={entry.id}>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-600">{new Date(entry.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-xs break-all">{entry.action}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 break-all">
                      {entry.resource_type ? <span className="block">{entry.resource_type}</span> : null}
                      {entry.resource_id ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600 break-all">{entry.ip_address ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 max-w-[240px]">
                      {details ? (
                        <details>
                          <summary className="cursor-pointer underline min-h-8 flex items-center">查看完整详情</summary>
                          <pre className="mt-2 whitespace-pre-wrap break-all max-h-64 overflow-auto">{details}</pre>
                        </details>
                      ) : '—'}
                    </td>
                  </tr>
                );
              })}
              {!loading && !error && items.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">暂无审计记录</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-col sm:flex-row gap-2 sm:justify-between sm:items-center text-sm text-gray-600">
          <span>共 {total} 条</span>
          <div className="flex items-center gap-3">
            <button type="button" disabled={loading || page <= 1} onClick={() => setPage((current) => current - 1)} className="min-h-9 px-2 disabled:opacity-40">
              上一页
            </button>
            <span>第 {page} / {Math.max(totalPages, 1)} 页</span>
            <button type="button" disabled={loading || page >= totalPages} onClick={() => setPage((current) => current + 1)} className="min-h-9 px-2 disabled:opacity-40">
              下一页
            </button>
          </div>
        </div>
      </main>
    </AppLayout>
  );
}
