import React, { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import {
  ChevronDown, ChevronRight, Calendar,
  User, ExternalLink, Edit2, AlertCircle,
  Copy, Check
} from "lucide-react";
import { fmtDate, fmtTimestampCustom, isOverdue, parseDate, todaySydney } from "@/components/utils/dateUtils";

const STAGES = [
  { key: 'to_be_scheduled', color: 'bg-gray-300' },
  { key: 'scheduled',       color: 'bg-blue-400' },
  { key: 'onsite',          color: 'bg-orange-400' },
  { key: 'uploaded',        color: 'bg-yellow-400' },
  { key: 'submitted',       color: 'bg-purple-400' },
  { key: 'in_progress',     color: 'bg-amber-400' },
  { key: 'ready_for_partial', color: 'bg-cyan-400' },
  { key: 'in_revision',     color: 'bg-red-400' },
  { key: 'delivered',       color: 'bg-green-500' },
];

const STATUS_BORDER = {
  to_be_scheduled: 'border-l-gray-300',
  scheduled: 'border-l-blue-400',
  onsite: 'border-l-orange-400',
  uploaded: 'border-l-yellow-400',
  submitted: 'border-l-purple-400',
  in_progress: 'border-l-amber-400',
  ready_for_partial: 'border-l-cyan-400',
  in_revision: 'border-l-red-500',
  delivered: 'border-l-green-500',
};

function PipelineBar({ status }) {
  const currentIdx = STAGES.findIndex(s => s.key === status);
  return (
    <div className="flex gap-0.5 mt-2">
      {STAGES.map((stage, i) => (
        <div
          key={stage.key}
          className={`h-1.5 flex-1 rounded-sm transition-colors ${i <= currentIdx ? stage.color : 'bg-gray-100'}`}
          title={stage.key.replace(/_/g, ' ')}
        />
      ))}
    </div>
  );
}

function Section({ title, badge, children, defaultOpen = true, action }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/50">
      <div className="flex items-center justify-between px-4 py-2">
        <button
          className="flex items-center gap-1.5 flex-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors text-left"
          onClick={() => setOpen(o => !o)}
        >
          {open
            ? <ChevronDown className="h-3 w-3" />
            : <ChevronRight className="h-3 w-3" />}
          <span>{title}</span>
          {badge !== undefined && badge > 0 && (
            <span className="ml-0.5 bg-muted text-muted-foreground text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
              {badge}
            </span>
          )}
        </button>
        {action && <div className="ml-2">{action}</div>}
      </div>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

function CopyableInfoRow({ label, value, href, Icon, copyValue }) {
  const [copied, setCopied] = React.useState(false);
  if (!value) return null;

  const handleCopy = (e) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(copyValue || value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex items-center justify-between py-1.5 px-4 group hover:bg-muted/30 transition-colors">
      <span className="text-[11px] text-muted-foreground shrink-0">{label}</span>
      <div className="flex items-center gap-1 min-w-0 ml-3 justify-end">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer"
            className="text-[12px] font-semibold text-primary hover:underline flex items-center gap-1 truncate">
            {value} <ExternalLink className="h-2.5 w-2.5 shrink-0" />
          </a>
        ) : (
          <span className="text-[12px] font-semibold text-foreground truncate">{value}</span>
        )}
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-0.5 rounded hover:bg-muted"
          title={`Copy ${label}`}
        >
          {copied
            ? <Check className="h-2.5 w-2.5 text-green-600" />
            : <Copy className="h-2.5 w-2.5 text-muted-foreground" />
          }
        </button>
      </div>
    </div>
  );
}

function InfoRow({ label, value, href, Icon }) {
  return <CopyableInfoRow label={label} value={value} href={href} Icon={Icon} />;
}

function fmtMoney(val) {
  if (!val) return null;
  if (val >= 1_000_000) return `A$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `A$${(val / 1_000).toFixed(1)}k`;
  return `A$${Math.round(val)}`;
}

function safeFmt(iso, pat) {
  // Use fmtDate for date-only strings, fmtTimestampCustom for full timestamps
  if (!iso) return null;
  if (String(iso).length <= 10) return fmtDate(iso, pat);
  return fmtTimestampCustom(iso, { day: 'numeric', month: 'short', year: 'numeric' });
}

const STATE_COLORS = {
  Active: "bg-green-100 text-green-800",
  Prospecting: "bg-blue-100 text-blue-800",
  Dormant: "bg-amber-100 text-amber-800",
  "Do Not Contact": "bg-red-100 text-red-800",
};

export default function Org2LeftPanel({
  agency, agents = [], teams = [], projects = [], onEditAgency,
  totalOrgRev = 0, avgOrgBookingValue = null,
  activeAgents = [], dormantAgents = [], atRiskAgents = [],
  revenueByAgent = []
}) {
   const openProjects  = projects.filter(p => p.outcome === 'open');
   const wonProjects   = projects.filter(p => p.outcome === 'won');
   const lostProjects  = projects.filter(p => p.outcome === 'lost');
   const wonRevenue    = wonProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
   const lostRevenue   = lostProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
   const closedCount   = wonProjects.length + lostProjects.length;
   const winRate       = closedCount > 0 ? Math.round((wonProjects.length / closedCount) * 100) : null;

   return (
     <div className="text-sm flex flex-col h-full">
       <div className="flex-1 overflow-y-auto">
         {/* Details */}
         <Section 
           title="Details" 
           defaultOpen={true}
           action={onEditAgency && (
             <Button 
               size="sm" 
               variant="ghost" 
               className="h-6 w-6 p-0"
               onClick={onEditAgency}
               title="Edit agency details"
             >
               <Edit2 className="h-3.5 w-3.5" />
             </Button>
           )}
         >
           <div>
             <InfoRow label="Status" value={agency.relationship_state || 'Unknown'} />
             <InfoRow label="Email" value={agency.email} href={agency.email ? `mailto:${agency.email}` : null} />
             <InfoRow label="Phone" value={agency.phone} href={agency.phone ? `tel:${agency.phone}` : null} />
             <InfoRow label="Address" value={agency.address} />
             <InfoRow label="Onboarding" value={safeFmt(agency.onboarding_date, 'dd MMM yyyy')} />
             <InfoRow label="Marketing contact" value={agency.primary_marketing_contact} />
             <InfoRow label="Accounts contact" value={agency.primary_accounts_contact} />
             <InfoRow label="Primary partner" value={agency.primary_partner} />
             <InfoRow label="WhatsApp" value={agency.whatsapp_group_chat ? "Open group chat" : null} href={agency.whatsapp_group_chat} />
             <InfoRow label="Pricing agreement" value={agency.pricing_agreement} />
             {agency.notes && (
               <div className="mx-4 mb-2 p-2 rounded-md bg-muted/40 text-[11px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
                 {agency.notes}
               </div>
             )}
           </div>
         </Section>

         {/* Organisation insights */}
         <Section title="Organisation insights" defaultOpen>
           <div>
             {/* People health */}
             <div className="flex items-center justify-between py-1.5 px-4">
               <span className="text-[11px] text-muted-foreground">People</span>
               <div className="flex items-center gap-1.5">
                 {activeAgents.length > 0 && (
                   <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold">
                     {activeAgents.length} active
                   </span>
                 )}
                 {dormantAgents.length > 0 && (
                   <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">
                     {dormantAgents.length} dormant
                   </span>
                 )}
                 {atRiskAgents.length > 0 && (
                   <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">
                     {atRiskAgents.length} at risk
                   </span>
                 )}
               </div>
             </div>

             {/* Revenue rows */}
             {totalOrgRev > 0 && (
               <>
                 <div className="flex items-center justify-between py-1.5 px-4">
                   <span className="text-[11px] text-muted-foreground">Total revenue</span>
                   <span className="text-[12px] font-semibold text-green-700">
                     ${totalOrgRev >= 1000000
                       ? `${(totalOrgRev / 1000000).toFixed(1)}M`
                       : totalOrgRev >= 1000
                       ? `${(totalOrgRev / 1000).toFixed(0)}k`
                       : totalOrgRev.toLocaleString()}
                   </span>
                 </div>
                 {avgOrgBookingValue && (
                   <div className="flex items-center justify-between py-1.5 px-4">
                     <span className="text-[11px] text-muted-foreground">Avg booking value</span>
                     <span className="text-[12px] font-semibold">
                       ${avgOrgBookingValue >= 1000
                         ? `${(avgOrgBookingValue / 1000).toFixed(0)}k`
                         : avgOrgBookingValue}
                     </span>
                   </div>
                 )}
                 <div className="flex items-center justify-between py-1.5 px-4">
                   <span className="text-[11px] text-muted-foreground">Total bookings</span>
                   <span className="text-[12px] font-semibold">{projects.length}</span>
                 </div>
               </>
             )}

             {/* Top performers */}
             {revenueByAgent.length > 0 && (
               <div className="border-t border-border/30 mt-1 pt-1">
                 <div className="py-1 px-4">
                   <span className="text-[11px] text-muted-foreground">Top performers</span>
                 </div>
                 {revenueByAgent.slice(0, 4).map(({ agent, rev, count }) => (
                   <div
                     key={agent.id}
                     className="flex items-center justify-between py-1 px-4"
                   >
                     <span className="text-[12px] truncate text-foreground font-medium max-w-[120px]">
                       {agent.name}
                     </span>
                     <div className="flex items-center gap-2 shrink-0">
                       <span className="text-[11px] text-muted-foreground">{count}x</span>
                       <span className="text-[12px] font-semibold text-green-700">
                         ${rev >= 1000 ? `${(rev / 1000).toFixed(0)}k` : rev}
                       </span>
                     </div>
                   </div>
                 ))}
               </div>
             )}

             {/* Website */}
             {agency?.website && (
               <div className="flex items-center justify-between py-1.5 px-4 border-t border-border/30 mt-1">
                 <span className="text-[11px] text-muted-foreground">Website</span>
                 <a
                   href={agency.website}
                   target="_blank"
                   rel="noopener noreferrer"
                   className="text-[12px] font-semibold text-primary hover:underline flex items-center gap-1 truncate ml-3"
                 >
                   {agency.website.replace(/^https?:\/\//, '')}
                   <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                 </a>
               </div>
             )}
           </div>
         </Section>

         {/* Quick Stats - Overdue Projects */}
      {useMemo(() => {
        const overdue = openProjects.filter(p => p.delivery_date && isOverdue(p.delivery_date));
        const dueThisWeek = openProjects.filter(p => {
          if (!p.delivery_date || isOverdue(p.delivery_date)) return false;
          const dueDate = parseDate(p.delivery_date);
          if (!dueDate) return false;
          const todayDate = parseDate(todaySydney());
          const weekDate = new Date(todayDate.getTime() + 7 * 24 * 60 * 60 * 1000);
          return dueDate >= todayDate && dueDate <= weekDate;
        });

        if (overdue.length > 0 || dueThisWeek.length > 0) {
          return (
            <div className="border-l-2 border-amber-400 bg-amber-50/50 mx-4 px-3 py-2 rounded text-xs space-y-1 mb-2">
              {overdue.length > 0 && (
                <div className="flex items-center gap-2 text-red-700">
                  <AlertCircle className="h-3 w-3" />
                  <span className="font-semibold">{overdue.length} overdue</span>
                </div>
              )}
              {dueThisWeek.length > 0 && (
                <div className="flex items-center gap-2 text-amber-700">
                  <Calendar className="h-3 w-3" />
                  <span className="font-semibold">{dueThisWeek.length} due this week</span>
                </div>
              )}
            </div>
          );
        }
        return null;
      }, [openProjects])}

      {/* Projects — open count only */}
      <Section title={`Projects${openProjects.length < projects.length ? ` (${openProjects.length} open)` : ''}`} badge={openProjects.length}>
        <div className="space-y-2 px-4">
          {openProjects.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No open projects</p>
          )}

          {openProjects.slice(0, 10).map(project => {
            const price = project.calculated_price || project.price;
            const isDelivered = project.status === 'delivered';
            return (
              <div key={project.id} className={`rounded-lg border-l-2 border border-l-current bg-background p-2.5 hover:shadow-sm transition-all group ${STATUS_BORDER[project.status] || 'border-l-gray-300'}`}>
                <Link
                  to={createPageUrl("ProjectDetails") + `?id=${project.id}`}
                  className="text-xs font-semibold hover:text-primary line-clamp-2 leading-tight block group-hover:text-primary transition-colors"
                >
                  {project.title}
                </Link>
                {project.agent_name && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                    <User className="h-2.5 w-2.5" />{project.agent_name}
                  </p>
                )}
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${isDelivered ? 'bg-green-100 text-green-800' : 'bg-blue-50 text-blue-700'}`}>
                    {isDelivered ? 'COMPLETED' : project.status?.replace(/_/g, ' ').toUpperCase()}
                  </span>
                  {price && (
                    <span className="text-[11px] font-bold text-foreground ml-auto">{fmtMoney(price)}</span>
                  )}
                </div>
                {/* Date range */}
                {(project.shoot_date || project.delivery_date) && (
                  <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                    {project.shoot_date && (
                      <>
                        <Calendar className="h-2.5 w-2.5 shrink-0" />
                        <span>{safeFmt(project.shoot_date, 'd MMM yy')}</span>
                      </>
                    )}
                    {project.shoot_date && project.delivery_date && <span>→</span>}
                    {project.delivery_date && (
                      <>
                        <Calendar className="h-2.5 w-2.5 shrink-0" />
                        <span>{safeFmt(project.delivery_date, 'd MMM yy')}</span>
                      </>
                    )}
                  </div>
                )}
                <PipelineBar status={project.status} />
              </div>
            );
          })}

          {openProjects.length > 10 && (
            <Button variant="outline" size="sm" className="w-full text-xs h-7 mt-1" asChild>
              <Link to={createPageUrl("Projects") + `?agency=${agency.id}`}>
                See all {openProjects.length} open projects
              </Link>
            </Button>
          )}

          {/* Won / Lost summary */}
          {closedCount > 0 && (
            <div className="mt-3 pt-3 border-t space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Won</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{wonProjects.length}</span>
                  {winRate !== null && <span className="text-muted-foreground">{winRate}%</span>}
                  {wonRevenue > 0 && <span className="font-bold text-green-700">{fmtMoney(wonRevenue)}</span>}
                </div>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Lost</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{lostProjects.length}</span>
                  {winRate !== null && <span className="text-muted-foreground">{100 - winRate}%</span>}
                  {lostRevenue > 0 && <span className="font-bold text-red-600">{fmtMoney(lostRevenue)}</span>}
                </div>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden bg-gray-200">
                <div className="bg-green-500" style={{ width: `${winRate || 0}%` }} />
                <div className="bg-red-400 flex-1" />
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Teams */}
      <Section title="Teams" badge={teams.length}>
        <div className="space-y-0.5 px-4">
          {teams.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No teams linked</p>
          )}
          {teams.slice(0, 12).map(team => {
            const teamProjects = projects.filter(p => p.onsite_staff_1_id === team.id || p.onsite_staff_2_id === team.id || p.image_editor_id === team.id || p.video_editor_id === team.id);
            return (
              <div key={team.id} className="flex items-center gap-2.5 p-1.5 rounded-md hover:bg-muted/50 transition-colors group">
                <div className="h-6 w-6 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-bold text-blue-700">
                    {(team.name || '?')[0].toUpperCase()}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate group-hover:text-primary transition-colors">{team.name}</p>
                  <p className="text-[10px] text-muted-foreground">{teamProjects.length} projects</p>
                </div>
              </div>
            );
          })}
          {teams.length > 12 && (
            <p className="text-[11px] text-muted-foreground pl-1.5 pt-1">+{teams.length - 12} more</p>
          )}
        </div>
      </Section>

      {/* People Summary — all relationship states */}
      {agents.length > 0 && (
        <div className="px-4 pt-1 pb-1 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold text-muted-foreground">People</span>
          {[
            { state: 'Active', cls: 'bg-green-100 text-green-700', label: 'active' },
            { state: 'Prospecting', cls: 'bg-blue-100 text-blue-700', label: 'prospecting' },
            { state: 'Dormant', cls: 'bg-amber-100 text-amber-700', label: 'dormant' },
            { state: 'Do Not Contact', cls: 'bg-red-100 text-red-700', label: 'DNC' },
          ].map(({ state, cls, label }) => {
            const count = agents.filter(a => a.relationship_state === state).length;
            if (count === 0) return null;
            return (
              <span key={state} className={`${cls} text-[10px] font-semibold px-1.5 py-0.5 rounded-full`}>
                {count} {label}
              </span>
            );
          })}
        </div>
      )}

      {/* People */}
      <Section title="People" badge={agents.length}>
        <div className="space-y-0.5 px-4">
          {agents.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No people linked</p>
          )}
          {agents.slice(0, 12).map(agent => (
            <Link
              key={agent.id}
              to={createPageUrl("PersonDetails") + `?id=${agent.id}`}
              className="flex items-center gap-2.5 p-1.5 rounded-md hover:bg-muted/50 transition-colors group"
            >
              <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-[10px] font-bold text-primary">
                  {(agent.name || '?')[0].toUpperCase()}
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium truncate group-hover:text-primary transition-colors">{agent.name}</p>
                {agent.title && <p className="text-[10px] text-muted-foreground truncate">{agent.title}</p>}
              </div>
              {agent.relationship_state && agent.relationship_state !== 'Prospecting' && (
                <span className={`ml-auto text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
                  agent.relationship_state === 'Active' ? 'bg-green-100 text-green-700' :
                  agent.relationship_state === 'Dormant' ? 'bg-amber-100 text-amber-700' :
                  'bg-red-100 text-red-700'
                }`}>{agent.relationship_state}</span>
              )}
            </Link>
          ))}
          {agents.length > 12 && (
            <p className="text-[11px] text-muted-foreground pl-1.5 pt-1">+{agents.length - 12} more</p>
          )}
          </div>
          </Section>
          </div>

          {/* Created date - bottom */}
          <div className="border-t mt-2 px-4 py-3 flex items-center justify-between text-[11px] text-muted-foreground">
            {safeFmt(agency.created_date, 'dd MMM yyyy') ? (
              <span>Added {safeFmt(agency.created_date, 'dd MMM yyyy')}</span>
            ) : <span />}
            {agency.became_active_date && (
              <span className="text-green-600 font-medium">Active since {safeFmt(agency.became_active_date, 'MMM yyyy')}</span>
            )}
          </div>
          </div>
          );
          }