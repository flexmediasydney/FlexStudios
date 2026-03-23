import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SmartFilterBar from '@/components/common/SmartFilterBar';

// Mock Radix Popover for jsdom
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }) => <div>{children}</div>,
  PopoverTrigger: ({ children }) => <>{children}</>,
  PopoverContent: ({ children }) => <div data-testid="popover-content">{children}</div>,
}));

const StarIcon = (props) => <svg data-testid="star-icon" {...props} />;
const FlagIcon = (props) => <svg data-testid="flag-icon" {...props} />;

const defaultFilters = [
  { id: 'starred', label: 'Starred', icon: StarIcon, count: 5 },
  { id: 'flagged', label: 'Flagged', icon: FlagIcon, count: 12 },
  { id: 'empty', label: 'Empty', icon: null, count: 0 },
];

describe('SmartFilterBar', () => {
  it('renders all quick filter pills', () => {
    render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set()}
        onToggleFilter={vi.fn()}
      />
    );

    expect(screen.getByText('Starred')).toBeInTheDocument();
    expect(screen.getByText('Flagged')).toBeInTheDocument();
    expect(screen.getByText('Empty')).toBeInTheDocument();
  });

  it('shows count badges when count > 0', () => {
    render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set()}
        onToggleFilter={vi.fn()}
      />
    );

    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    // count=0 should NOT render a badge
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows 99+ for counts over 99', () => {
    const filters = [
      { id: 'many', label: 'Many', icon: null, count: 150 },
    ];
    render(
      <SmartFilterBar
        quickFilters={filters}
        activeFilters={new Set()}
        onToggleFilter={vi.fn()}
      />
    );

    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('calls onToggleFilter with filter id when pill is clicked', () => {
    const onToggle = vi.fn();
    render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set()}
        onToggleFilter={onToggle}
      />
    );

    fireEvent.click(screen.getByText('Starred'));
    expect(onToggle).toHaveBeenCalledWith('starred');

    fireEvent.click(screen.getByText('Flagged'));
    expect(onToggle).toHaveBeenCalledWith('flagged');
  });

  it('applies active styling when filter is in activeFilters set', () => {
    const { container } = render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set(['starred'])}
        onToggleFilter={vi.fn()}
      />
    );

    // The active pill should have bg-primary class
    const starredBtn = screen.getByText('Starred').closest('button');
    expect(starredBtn.className).toContain('bg-primary');

    // Inactive pill should not
    const flaggedBtn = screen.getByText('Flagged').closest('button');
    expect(flaggedBtn.className).not.toContain('bg-primary text-primary-foreground');
  });

  it('shows Clear button when filters are active', () => {
    render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set(['starred'])}
        onToggleFilter={vi.fn()}
        onClearAll={vi.fn()}
      />
    );

    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('does not show Clear button when no filters are active', () => {
    render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set()}
        onToggleFilter={vi.fn()}
        onClearAll={vi.fn()}
      />
    );

    expect(screen.queryByText('Clear')).not.toBeInTheDocument();
  });

  it('calls onClearAll when Clear is clicked', () => {
    const onClearAll = vi.fn();
    render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set(['starred'])}
        onToggleFilter={vi.fn()}
        onClearAll={onClearAll}
      />
    );

    fireEvent.click(screen.getByText('Clear'));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it('shows filtered/total count when they differ', () => {
    render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set(['starred'])}
        onToggleFilter={vi.fn()}
        onClearAll={vi.fn()}
        totalCount={50}
        filteredCount={15}
      />
    );

    expect(screen.getByText('15 of 50')).toBeInTheDocument();
  });

  it('does not show count text when filteredCount equals totalCount', () => {
    render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set(['starred'])}
        onToggleFilter={vi.fn()}
        onClearAll={vi.fn()}
        totalCount={50}
        filteredCount={50}
      />
    );

    expect(screen.queryByText('50 of 50')).not.toBeInTheDocument();
  });

  it('renders with empty quickFilters array', () => {
    const { container } = render(
      <SmartFilterBar
        quickFilters={[]}
        activeFilters={new Set()}
        onToggleFilter={vi.fn()}
      />
    );

    expect(container.firstChild).toBeInTheDocument();
  });

  it('renders icons when provided', () => {
    render(
      <SmartFilterBar
        quickFilters={defaultFilters}
        activeFilters={new Set()}
        onToggleFilter={vi.fn()}
      />
    );

    expect(screen.getAllByTestId('star-icon').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('flag-icon').length).toBeGreaterThanOrEqual(1);
  });
});
