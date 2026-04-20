export default function Topbar({ title, text }: { title: string; text: string }) {
  return (
    <div className="db-topbar">
      <div>
        <h1 className="db-topbar__title">{title}</h1>
        <p className="db-topbar__text">{text}</p>
      </div>
      <div className="db-topbar__user">Admin</div>
    </div>
  );
}