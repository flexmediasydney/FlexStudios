/**
 * PropertyMergeTool — admin page for merging duplicate properties
 *
 * When the normalizer fails to detect two properties as the same (e.g.
 * typos, different unit conventions), this page surfaces similarity-scored
 * candidates and lets admins approve merges.
 *
 * Note: most candidates shown are legitimately different (e.g. 11 vs 1/11
 * same address = different unit vs whole building). Admin judgment required.
 */
import React, { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  GitMerge, Loader2, ArrowRight, Check, X, RefreshCw, AlertTriangle, Home, MapPin,
} from "lucide-react";

export default function PropertyMergeTool() {
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(null); // the pair id being merged

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await api._supabase
        .from("property_merge_candidates_v")
        .select("*")
        .order("sim_score", { ascending: false })
        .limit(100);
      if (error) throw error;
      setCandidates(data || []);
    } catch (err) {
      console.error("Failed to load candidates:", err);
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCandidates(); }, [fetchCandidates]);

  const handleMerge = async (pair, winnerId, loserId) => {
    const pairId = `${pair.a_id}:${pair.b_id}`;
    setMerging(pairId);
    try {
      const { data, error } = await api.rpc("merge_properties", {
        p_winner_id: winnerId,
        p_loser_id: loserId,
      });
      if (error) throw error;
      if (data?.success) {
        toast.success(
          `Merged · ${data.listings_affected} listings, ${data.projects_affected} projects now consolidated`
        );
        // Remove from UI
        setCandidates((prev) =>
          prev.filter(
            (c) => c.a_id !== pair.a_id || c.b_id !== pair.b_id
          )
        );
      } else {
        toast.error(data?.error || "Merge failed");
      }
    } catch (err) {
      toast.error(`Merge failed: ${err.message || "unknown"}`);
    } finally {
      setMerging(null);
    }
  };

  const handleReject = (pair) => {
    // For now just hide from UI; future: persist a "rejected" flag
    setCandidates((prev) =>
      prev.filter(
        (c) => c.a_id !== pair.a_id || c.b_id !== pair.b_id
      )
    );
    toast.message("Hidden for this session");
  };

  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <GitMerge className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Property Merge Tool</h1>
          <Badge variant="outline" className="text-[10px]">{candidates.length} candidates</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchCandidates} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      <Card className="rounded-xl bg-amber-50/40 border-amber-200/60">
        <CardContent className="p-3 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="flex-1 text-xs">
            <p className="font-semibold mb-0.5">Admin judgment required</p>
            <p className="text-muted-foreground leading-relaxed">
              Most candidates listed are LEGITIMATELY DIFFERENT properties (e.g. unit 1 vs unit 2 of
              the same building). Only merge when you're certain they're the same physical address.
              Merging moves all listings and projects to the winner. Loser row is soft-deleted
              (`is_merged = true`) and hidden from views.
            </p>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <Card><CardContent className="py-12 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading candidates…
        </CardContent></Card>
      ) : candidates.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">
          <GitMerge className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No merge candidates found — all properties appear unique.</p>
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {candidates.map((c) => (
            <MergeCandidateRow
              key={`${c.a_id}-${c.b_id}`}
              pair={c}
              onMerge={handleMerge}
              onReject={handleReject}
              merging={merging === `${c.a_id}:${c.b_id}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MergeCandidateRow({ pair, onMerge, onReject, merging }) {
  const scorePct = Math.round(pair.sim_score * 100);
  const scoreColor =
    pair.sim_score >= 0.95 ? "text-emerald-600" :
    pair.sim_score >= 0.85 ? "text-amber-600" :
    "text-muted-foreground";

  return (
    <Card className="rounded-xl">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline" className={cn("text-[10px]", scoreColor)}>
            {scorePct}% match
          </Badge>
          <span className="text-muted-foreground">· {pair.a_suburb || "—"}</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="flex items-start gap-2 p-2 rounded-md border border-border/60 bg-muted/20">
            <Home className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">{pair.a_addr}</p>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">key: {pair.a_key}</p>
              <div className="flex items-center gap-2 mt-1">
                <Link
                  to={`/PropertyDetails?key=${encodeURIComponent(pair.a_key)}`}
                  target="_blank"
                  className="text-[10px] text-primary hover:underline"
                >
                  View →
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px]"
                  disabled={merging}
                  onClick={() => onMerge(pair, pair.a_id, pair.b_id)}
                >
                  Keep this, merge other →
                </Button>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2 p-2 rounded-md border border-border/60 bg-muted/20">
            <Home className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">{pair.b_addr}</p>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">key: {pair.b_key}</p>
              <div className="flex items-center gap-2 mt-1">
                <Link
                  to={`/PropertyDetails?key=${encodeURIComponent(pair.b_key)}`}
                  target="_blank"
                  className="text-[10px] text-primary hover:underline"
                >
                  View →
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px]"
                  disabled={merging}
                  onClick={() => onMerge(pair, pair.b_id, pair.a_id)}
                >
                  Keep this, merge other →
                </Button>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => onReject(pair)} disabled={merging}>
            <X className="h-3 w-3 mr-1" /> Not a duplicate
          </Button>
          {merging && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
      </CardContent>
    </Card>
  );
}
