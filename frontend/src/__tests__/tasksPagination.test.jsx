import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Tasks from '../pages/Tasks';
import api from '../lib/axios';

vi.mock('../lib/axios', () => ({
  default: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
  registerAuthStore: vi.fn(),
}));
vi.mock('../store/auth', () => ({
  default: () => ({
    hydrated: true,
    accessToken: 'token',
    user: { role: 'ADMIN' },
  }),
}));
vi.mock('sonner', () => ({ toast: {} }));

describe('Issue #1067: Tasks Page Pagination', () => {
  it('renders at most 20 tasks per page and paginates', async () => {
    const mockTasks = Array.from({ length: 45 }, (_, i) => ({
      id: i + 1,
      title: `Task #${i + 1}`,
    }));
    api.get.mockImplementation((url) =>
      Promise.resolve({ data: url === '/tasks' ? mockTasks : [] })
    );

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <Tasks />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText('Task #1')).toBeInTheDocument();
    expect(screen.getByText('Task #20')).toBeInTheDocument();
    expect(screen.queryByText('Task #21')).not.toBeInTheDocument();
    expect(
      screen.getByText(/showing 1 to 20 of 45 tasks/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText('Task #21')).toBeInTheDocument();
    expect(screen.queryByText('Task #1')).not.toBeInTheDocument();
    expect(
      screen.getByText(/showing 21 to 40 of 45 tasks/i)
    ).toBeInTheDocument();
  });
});
