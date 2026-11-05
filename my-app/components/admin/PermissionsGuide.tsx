// ---------------------------------------------------------------------------
// PermissionsGuide
// The few steps at the top of the Roles & permissions tab. The lines below it
// say in words what each one allows, so the steps only need to say how the
// tab and the Users tab fit together.
// ---------------------------------------------------------------------------

export function PermissionsGuide({ showViewAs }: { showViewAs: boolean }) {
  return (
    <ol className="role-steps" aria-label="How to set up a role">
      <li>Pick a role, or make a new one.</li>
      <li>
        Turn on what it may do, then press <b>Save changes</b>.
      </li>
      <li>
        Give it to people on the <b>Users</b> tab.
      </li>
      {showViewAs && (
        <li>
          Check it with <b>View as</b> on the sidebar.
        </li>
      )}
    </ol>
  );
}
