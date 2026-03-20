import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export default function ResponsiveTable({ columns = [], data = [], rowKey = "id", className }) {
  const [expandedRows, setExpandedRows] = useState({});

  const toggleRow = (key) => {
    setExpandedRows(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="overflow-x-auto">
      <Table className={className}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            {columns.map(col => (
              <TableHead key={col.key}>{col.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row, idx) => (
            <TableRow key={row[rowKey]}>
              <TableCell>
                <button onClick={() => toggleRow(row[rowKey])} className="p-1">
                  {expandedRows[row[rowKey]] ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              </TableCell>
              {columns.map(col => (
                <TableCell key={col.key}>
                  {col.render ? col.render(row[col.key], row) : row[col.key]}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}