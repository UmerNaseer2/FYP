import { HelpHint } from "@/components/ui/HelpHint";

// ---------------------------------------------------------------------------
// PermissionsGuide
// The one line at the top of the Roles & permissions tab, with the steps for
// setting up a role one click away. The same steps are in the page's help
// (lib/help/admin.ts, "Setting up a role").
// ---------------------------------------------------------------------------

export function PermissionsGuide({ showViewAs }: { showViewAs: boolean }) {
  return (
    <p className="text-[13.5px] flex-1 min-w-0" style={{ color: "var(--text-2)" }}>
      Decide what each role may do.
      <HelpHint label="How to set up a role">
        Pick a role or make a new one. Turn on what it may do, then press <b>Save changes</b>. Give
        it to people on the <b>Users</b> tab.
        {showViewAs && (
          <>
            {" "}
            Check it with <b>View as</b> on the sidebar.
          </>
        )}
      </HelpHint>
    </p>
  );
}
