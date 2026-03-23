import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PhoneInput from '../PhoneInput';

// Mock Radix Select since jsdom can't handle portals well
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange, disabled }) => (
    <div data-testid="select-root">
      {children}
      <select
        data-testid="country-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        <option value="+61">AU +61</option>
        <option value="+64">NZ +64</option>
        <option value="+1">US +1</option>
        <option value="+44">UK +44</option>
        <option value="+91">IN +91</option>
        <option value="+63">PH +63</option>
      </select>
    </div>
  ),
  SelectContent: ({ children }) => <>{children}</>,
  SelectItem: ({ children, value }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }) => <>{children}</>,
  SelectValue: () => null,
}));

describe('PhoneInput', () => {
  it('renders with default AU +61 country code', () => {
    render(<PhoneInput onChange={vi.fn()} />);
    const select = screen.getByTestId('country-select');
    expect(select.value).toBe('+61');
  });

  it('renders phone number input with placeholder', () => {
    render(<PhoneInput onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText('412 345 678')).toBeInTheDocument();
  });

  it('calls onChange with E.164 format when number is typed', async () => {
    const onChange = vi.fn();
    render(<PhoneInput onChange={onChange} />);

    const input = screen.getByPlaceholderText('412 345 678');
    fireEvent.change(input, { target: { value: '412345678' } });

    expect(onChange).toHaveBeenCalledWith('+61412345678');
  });

  it('strips non-numeric characters from input', () => {
    const onChange = vi.fn();
    render(<PhoneInput onChange={onChange} />);

    const input = screen.getByPlaceholderText('412 345 678');
    fireEvent.change(input, { target: { value: '04-1234 5678' } });

    // Should strip dashes and spaces, keeping only digits
    expect(onChange).toHaveBeenCalledWith('+610412345678');
  });

  it('updates E.164 output when country code changes', () => {
    const onChange = vi.fn();
    render(<PhoneInput onChange={onChange} />);

    // Type a number first
    const input = screen.getByPlaceholderText('412 345 678');
    fireEvent.change(input, { target: { value: '412345678' } });
    onChange.mockClear();

    // Switch to US +1
    const select = screen.getByTestId('country-select');
    fireEvent.change(select, { target: { value: '+1' } });

    expect(onChange).toHaveBeenCalledWith('+1412345678');
  });

  it('calls onChange with just country code when number is empty and code changes', () => {
    const onChange = vi.fn();
    render(<PhoneInput onChange={onChange} />);

    const select = screen.getByTestId('country-select');
    fireEvent.change(select, { target: { value: '+44' } });

    expect(onChange).toHaveBeenCalledWith('+44');
  });

  it('disables both select and input when disabled prop is true', () => {
    render(<PhoneInput onChange={vi.fn()} disabled />);

    const select = screen.getByTestId('country-select');
    const input = screen.getByPlaceholderText('412 345 678');

    expect(select).toBeDisabled();
    expect(input).toBeDisabled();
  });

  it('does not crash when onChange is undefined', () => {
    render(<PhoneInput />);

    const input = screen.getByPlaceholderText('412 345 678');
    expect(() => {
      fireEvent.change(input, { target: { value: '412345678' } });
    }).not.toThrow();
  });
});
