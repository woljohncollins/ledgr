// The Work home (/). If the owner has assigned a dashboard as Home, render it;
// otherwise the fixed Today layout (the default + fallback). The Today surface
// (/today) mirrors this with todayDashboardId.
//
// The layout itself lives in `_today-home.tsx` because /today renders it too, and
// a page file may not carry extra named exports (it broke the build as one).
import DashboardView from "@/components/dashboards/DashboardView";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";
import TodayHome from "@/app/_today-home";

export const dynamic = "force-dynamic";

export default async function Home() {
  const owner = await resolveOwner();
  if (!owner) return <TodayHome />;
  const settings = await getSettings(owner.id);
  if (settings.homeDashboardId) {
    // Renders the dashboard, or falls back to the fixed Today layout if the
    // assigned dashboard was since deleted.
    return (
      <DashboardView
        ownerId={owner.id}
        dashboardId={settings.homeDashboardId}
        fallback={<TodayHome />}
      />
    );
  }
  return <TodayHome />;
}
