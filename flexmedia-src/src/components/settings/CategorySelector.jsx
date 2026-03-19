import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';

export default function CategorySelector({ projectTypeId, value, onChange, label = 'Product Category' }) {
  const { data: categories = [] } = useQuery({
    queryKey: ['productCategories', projectTypeId],
    queryFn: () => projectTypeId 
      ? base44.entities.ProductCategory.filter({ project_type_id: projectTypeId }, 'order')
      : Promise.resolve([]),
    enabled: !!projectTypeId
  });

  return (
    <div>
      {label && <Label className="text-xs mb-1 block text-muted-foreground">{label} (optional)</Label>}
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder="All categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={null}>All categories</SelectItem>
          {categories.map(cat => (
            <SelectItem key={cat.id} value={cat.name}>
              {cat.icon} {cat.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}