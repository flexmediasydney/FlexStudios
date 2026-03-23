import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import AccessBadge from '@/components/auth/AccessBadge';
import { api } from '@/api/supabaseClient';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertCircle, Plus, Trash2, CheckCircle2, AlertTriangle, Loader2, Copy, Edit2, Eye, EyeOff, ArrowUp, ArrowDown, Grid3x3, Table as TableIcon } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import DeleteConfirmationDialogComponent from '../common/DeleteConfirmationDialog';

const CATEGORY_ICONS = ['📷', '🎬', '🚁', '✂️', '🛋️', '🎨', '📸', '🎥', '📹', '🖼️', '🏠', '💡', '🔧'];
const CATEGORY_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4', '#f59e0b'];

function CategoryForm({ projectType, initialData, onSubmit, onCancel, isLoading }) {
  const [formData, setFormData] = useState(initialData || { name: '', icon: '📷', color: '#3b82f6', is_active: true });
  const [errors, setErrors] = useState({});

  const validate = () => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = 'Category name is required';
    if (formData.name.length > 50) newErrors.name = 'Name must be 50 characters or less';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (validate()) {
      onSubmit({ ...formData, project_type_id: projectType.id, project_type_name: projectType.name });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border rounded-lg p-4 bg-muted/30 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label htmlFor="name" className="text-xs font-medium mb-1.5 block">
            Category Name *
          </Label>
          <Input
            id="name"
            placeholder="e.g., Photography"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="h-9 text-sm"
            maxLength={50}
            disabled={isLoading}
          />
          {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
          <p className="text-xs text-muted-foreground mt-1">{formData.name.length}/50</p>
        </div>

        <div>
          <Label htmlFor="icon" className="text-xs font-medium mb-1.5 block">
            Icon
          </Label>
          <Select value={formData.icon} onValueChange={(icon) => setFormData({ ...formData, icon })} disabled={isLoading}>
            <SelectTrigger id="icon" className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_ICONS.map(icon => (
                <SelectItem key={icon} value={icon}>{icon} {icon}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label className="text-xs font-medium mb-2 block">Color</Label>
        <div className="flex gap-1.5 flex-wrap">
          {CATEGORY_COLORS.map(color => (
            <button
              key={color}
              type="button"
              className={`w-7 h-7 rounded-lg border-2 transition-all hover:scale-110 ${
                formData.color === color ? 'border-foreground ring-2 ring-offset-1' : 'border-border'
              }`}
              style={{ backgroundColor: color }}
              onClick={() => setFormData({ ...formData, color })}
              title={color}
            />
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={isLoading} size="sm" className="gap-1.5">
          {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {initialData ? 'Update' : 'Create'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading} size="sm">
          Cancel
        </Button>
      </div>
    </form>
  );
}



function CategoryCard({ category, onEdit, onDelete, projectType, disabled }) {
  return (
    <div className="border rounded-lg p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div 
            className="w-10 h-10 rounded-lg flex items-center justify-center text-xl"
            style={{ backgroundColor: category.color + '20' }}
          >
            {category.icon}
          </div>
          <div>
            <p className="font-medium text-sm">{category.name}</p>
            <p className="text-xs text-muted-foreground">ID: {category.id.slice(0, 8)}...</p>
          </div>
        </div>
        <div className="w-5 h-5 rounded" style={{ backgroundColor: category.color }} title={category.color} />
      </div>

      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onEdit(category)}
          className="gap-1.5"
          disabled={disabled}
        >
          <Edit2 className="h-3.5 w-3.5" />
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(category)}
          className="gap-1.5 text-destructive hover:text-destructive"
          disabled={disabled}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}

export default function ProductCategoriesManagement() {
  const { canEdit, canView } = useEntityAccess('product_categories');
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('');
  const [viewMode, setViewMode] = useState('grid');
  const [expandedFormType, setExpandedFormType] = useState(null);
  const [editingCategory, setEditingCategory] = useState(null);
  const [deleteDialog, setDeleteDialog] = useState({ open: false, category: null, impact: null });
  const [notification, setNotification] = useState(null);

  const { data: projectTypes = [] } = useQuery({
    queryKey: ['projectTypes'],
    queryFn: () => api.entities.ProjectType.list(),
    staleTime: 60000
  });

  const { data: allCategories = [], refetch: refetchCategories } = useQuery({
    queryKey: ['productCategories'],
    queryFn: () => api.entities.ProductCategory.list(),
    staleTime: 5000
  });

  useEffect(() => {
    if (projectTypes.length > 0 && !activeTab) {
      setActiveTab(projectTypes[0].id);
    }
  }, [projectTypes, activeTab]);

  useEffect(() => {
    const unsubscribe = api.entities.ProductCategory.subscribe(() => {
      refetchCategories();
    });
    return unsubscribe;
  }, [refetchCategories]);

  const createMutation = useMutation({
    mutationFn: (data) => api.entities.ProductCategory.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productCategories'] });
      setExpandedFormType(null);
      setEditingCategory(null);
      showNotification('success', 'Category created successfully');
    },
    onError: (err) => showNotification('error', err.message || 'Failed to create category')
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.entities.ProductCategory.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productCategories'] });
      setEditingCategory(null);
      setExpandedFormType(null);
      showNotification('success', 'Category updated successfully');
    },
    onError: (err) => showNotification('error', err.message || 'Failed to update category')
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      await api.entities.ProductCategory.delete(id);
      await new Promise(r => setTimeout(r, 500));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productCategories'] });
      setDeleteDialog({ open: false, category: null, impact: null });
      showNotification('success', 'Category deleted successfully');
    },
    onError: (err) => showNotification('error', err.message || 'Failed to delete category')
  });

  const showNotification = useCallback((type, message) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  }, []);

  const handleDeleteClick = async (category) => {
    try {
      const response = await api.functions.invoke('analyzeCategoryImpact', {
        categoryId: category.id,
        categoryName: category.name
      });
      setDeleteDialog({ open: true, category, impact: response.data });
    } catch (err) {
      setDeleteDialog({ open: true, category, impact: null });
    }
  };

  const handleFormSubmit = (data) => {
    if (editingCategory) {
      updateMutation.mutate({ id: editingCategory.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const getCategoriesForType = useCallback((typeId) => {
    return allCategories.filter(c => c.project_type_id === typeId).sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [allCategories]);

  if (!canView) return <div className="p-8 text-center text-muted-foreground">You don't have access to this section.</div>;

  return (
    <div className="space-y-4">
      {notification && (
        <div className={`p-3 rounded-lg flex items-center gap-2 text-sm animate-in fade-in slide-in-from-top-2 ${
          notification.type === 'success'
            ? 'bg-green-50 text-green-900 border border-green-200'
            : 'bg-red-50 text-red-900 border border-red-200'
        }`}>
          {notification.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
          )}
          {notification.message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Product Categories <AccessBadge entityType="product_categories" /></CardTitle>
          <CardDescription>Manage categories for each project type</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full justify-start bg-transparent border-b rounded-none p-0 h-auto gap-1 mb-6">
              {projectTypes.map(type => (
                <TabsTrigger
                  key={type.id}
                  value={type.id}
                  className="px-4 py-2 rounded-t-lg border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-muted"
                >
                  {type.name}
                </TabsTrigger>
              ))}
            </TabsList>

            {projectTypes.map(type => {
              const categories = getCategoriesForType(type.id);
              const isExpanded = expandedFormType === type.id;

              return (
                <TabsContent key={type.id} value={type.id} className="space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex gap-1">
                      <Button
                        onClick={() => setViewMode('grid')}
                        variant={viewMode === 'grid' ? 'default' : 'outline'}
                        size="sm"
                        className="gap-1.5"
                      >
                        <Grid3x3 className="h-4 w-4" />
                        Grid
                      </Button>
                      <Button
                        onClick={() => setViewMode('table')}
                        variant={viewMode === 'table' ? 'default' : 'outline'}
                        size="sm"
                        className="gap-1.5"
                      >
                        <TableIcon className="h-4 w-4" />
                        Table
                      </Button>
                    </div>
                    {!isExpanded && (
                      <Button
                        onClick={() => setExpandedFormType(type.id)}
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={!canEdit}
                      >
                        <Plus className="h-4 w-4" />
                        New Category
                      </Button>
                    )}
                  </div>

                  {isExpanded ? (
                    <CategoryForm
                      projectType={type}
                      initialData={editingCategory}
                      onSubmit={handleFormSubmit}
                      onCancel={() => {
                        setExpandedFormType(null);
                        setEditingCategory(null);
                      }}
                      isLoading={createMutation.isPending || updateMutation.isPending}
                    />
                  ) : null}

                  {categories.length > 0 && viewMode === 'grid' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {categories.map(category => (
                        <CategoryCard
                          key={category.id}
                          category={category}
                          projectType={type}
                          disabled={!canEdit}
                          onEdit={(cat) => {
                            setEditingCategory(cat);
                            setExpandedFormType(type.id);
                          }}
                          onDelete={handleDeleteClick}
                        />
                      ))}
                    </div>
                  )}

                  {categories.length > 0 && viewMode === 'table' && (
                    <div className="border rounded-lg overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted">
                            <TableHead className="text-xs font-semibold">Icon</TableHead>
                            <TableHead className="text-xs font-semibold">Name</TableHead>
                            <TableHead className="text-xs font-semibold">Color</TableHead>
                            <TableHead className="text-xs font-semibold">Order</TableHead>
                            <TableHead className="text-xs font-semibold text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {categories.map(category => (
                            <TableRow key={category.id} className="hover:bg-muted/50">
                              <TableCell className="text-lg">{category.icon}</TableCell>
                              <TableCell className="font-medium text-sm">{category.name}</TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <div className="w-4 h-4 rounded border" style={{ backgroundColor: category.color }} />
                                  <span className="text-xs text-muted-foreground font-mono">{category.color}</span>
                                </div>
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">{category.order || 0}</TableCell>
                              <TableCell className="text-right">
                                <div className="flex gap-1 justify-end">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      setEditingCategory(category);
                                      setExpandedFormType(type.id);
                                    }}
                                    className="h-7 px-2"
                                    disabled={!canEdit}
                                  >
                                    <Edit2 className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleDeleteClick(category)}
                                    className="h-7 px-2 text-destructive hover:text-destructive"
                                    disabled={!canEdit}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}

                  {categories.length === 0 && !isExpanded && (
                    <div className="text-center py-8 text-muted-foreground">
                      <p className="text-sm">No categories yet for {type.name}</p>
                    </div>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        </CardContent>
      </Card>

      <DeleteConfirmationDialogComponent
        open={deleteDialog.open}
        itemName={deleteDialog.category?.name}
        itemType="category"
        impact={deleteDialog.impact}
        isLoading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(deleteDialog.category.id)}
        onCancel={() => setDeleteDialog({ open: false, category: null, impact: null })}
      />
    </div>
  );
}