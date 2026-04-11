import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Copy, Trash2, KeyRound, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  let code = 'FLEX-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default function InviteCodesPanel() {
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const [showCreate, setShowCreate] = useState(false);
  const [deletingCode, setDeletingCode] = useState(null);
  const [newCode, setNewCode] = useState({ code: generateCode(), role: 'employee', max_uses: 1, note: '', expires_days: '' });

  const { data: codes = [], isLoading } = useQuery({
    queryKey: ['invite-codes'],
    queryFn: () => api.entities.InviteCode.list('-created_at', 200),
  });

  const createMutation = useMutation({
    mutationFn: (data) => api.entities.InviteCode.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invite-codes'] });
      toast.success('Invite code created');
      setShowCreate(false);
      setNewCode({ code: generateCode(), role: 'employee', max_uses: 1, note: '', expires_days: '' });
    },
    onError: (err) => toast.error(err?.message || 'Failed to create code'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.entities.InviteCode.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invite-codes'] });
      toast.success('Code deleted');
    },
    onError: (err) => toast.error(err?.message || 'Failed to delete'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }) => api.entities.InviteCode.update(id, { is_active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invite-codes'] });
      toast.success('Code updated');
    },
  });

  const handleCreate = () => {
    const cleanCode = newCode.code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (cleanCode.length < 4 || cleanCode.length > 20) {
      toast.error('Code must be 4-20 characters (letters, numbers, dashes only)');
      return;
    }
    if (parseInt(newCode.max_uses) < 1) {
      toast.error('Max uses must be at least 1');
      return;
    }
    const data = {
      code: cleanCode,
      role: newCode.role,
      max_uses: parseInt(newCode.max_uses) || 1,
      note: (newCode.note || '').trim() || null,
      created_by: currentUser?.id || null,
      created_by_name: currentUser?.full_name || null,
      expires_at: newCode.expires_days
        ? new Date(Date.now() + parseInt(newCode.expires_days) * 86400000).toISOString()
        : null,
    };
    createMutation.mutate(data);
  };

  const copyCode = (code) => {
    navigator.clipboard.writeText(code);
    toast.success('Code copied to clipboard');
  };

  const roleLabel = { master_admin: 'Admin', admin: 'Admin', employee: 'Staff' };
  const roleBadge = { master_admin: 'bg-red-100 text-red-700', admin: 'bg-red-100 text-red-700', employee: 'bg-blue-100 text-blue-700' };

  const activeCodes = useMemo(() => codes.filter(c => c.is_active), [codes]);
  const expiredCodes = useMemo(() => codes.filter(c => !c.is_active), [codes]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Invite Codes</h3>
          <p className="text-xs text-muted-foreground">{activeCodes.length} active, {expiredCodes.length} expired/disabled</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" /> Generate Code
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : codes.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          <KeyRound className="h-8 w-8 mx-auto mb-2 opacity-30" />
          No invite codes yet. Generate one to let new users sign up.
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.map(code => {
                const isExpired = code.expires_at && new Date(code.expires_at) < new Date();
                const isMaxed = code.max_uses && code.use_count >= code.max_uses;
                const status = !code.is_active ? 'disabled' : isExpired ? 'expired' : isMaxed ? 'used up' : 'active';

                return (
                  <TableRow key={code.id} className={!code.is_active ? 'opacity-50' : ''}>
                    <TableCell>
                      <button
                        onClick={() => copyCode(code.code)}
                        className="font-mono text-sm font-semibold hover:text-blue-600 flex items-center gap-1.5"
                        title="Click to copy"
                      >
                        {code.code}
                        <Copy className="h-3 w-3 opacity-40" />
                      </button>
                      {code.note && <div className="text-xs text-muted-foreground mt-0.5">{code.note}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${roleBadge[code.role] || ''}`}>
                        {roleLabel[code.role] || code.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {code.use_count}/{code.max_uses || '∞'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {code.created_at ? formatDistanceToNow(new Date(code.created_at), { addSuffix: true }) : '—'}
                      {code.created_by_name && <div className="text-[10px]">by {code.created_by_name}</div>}
                    </TableCell>
                    <TableCell>
                      {status === 'active' && (
                        <Badge variant="outline" className="bg-green-50 text-green-700 text-[10px]">
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Active
                        </Badge>
                      )}
                      {status === 'expired' && <Badge variant="outline" className="text-[10px] text-red-600">Expired</Badge>}
                      {status === 'used up' && <Badge variant="outline" className="text-[10px] text-amber-600">Used up</Badge>}
                      {status === 'disabled' && <Badge variant="outline" className="text-[10px] text-gray-500">Disabled</Badge>}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => toggleMutation.mutate({ id: code.id, is_active: !code.is_active })}
                          title={code.is_active ? 'Disable' : 'Enable'}
                        >
                          {code.is_active ? <XCircle className="h-3.5 w-3.5 text-red-500" /> : <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setDeletingCode(code)}
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Delete Confirmation */}
      {deletingCode && (
        <AlertDialog open={!!deletingCode} onOpenChange={() => setDeletingCode(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete invite code?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete the code <strong>{deletingCode.code}</strong>. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { deleteMutation.mutate(deletingCode.id); setDeletingCode(null); }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Create Code Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Generate Invite Code</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Code</Label>
              <div className="flex gap-2">
                <Input
                  value={newCode.code}
                  onChange={(e) => setNewCode(p => ({ ...p, code: e.target.value.toUpperCase() }))}
                  className="font-mono text-center tracking-wider"
                />
                <Button variant="outline" size="icon" onClick={() => setNewCode(p => ({ ...p, code: generateCode() }))} title="Regenerate">
                  <KeyRound className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Role assigned to new user</Label>
              <Select value={newCode.role} onValueChange={(v) => setNewCode(p => ({ ...p, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">Staff</SelectItem>
                  <SelectItem value="master_admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Max uses</Label>
                <Input
                  type="number"
                  min={1}
                  value={newCode.max_uses}
                  onChange={(e) => setNewCode(p => ({ ...p, max_uses: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Expires in (days)</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="Never"
                  value={newCode.expires_days}
                  onChange={(e) => setNewCode(p => ({ ...p, expires_days: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Note (optional)</Label>
              <Input
                placeholder="e.g. For the new photography team"
                value={newCode.note}
                onChange={(e) => setNewCode(p => ({ ...p, note: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newCode.code.trim() || createMutation.isPending}>
              {createMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Creating...</> : 'Create Code'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
