import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";

export default function ScriptsPage() {
  const scripts = [
    "ALTER TABLE users ADD COLUMN last_login TIMESTAMP;",
    "CREATE INDEX idx_orders_status ON orders(status);",
    "ALTER TABLE payments ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);",
  ];

  return (
    <div className="db-layout">
      <Sidebar current="SQL Scripts" />

      <main className="db-main">
        <Topbar
          title="SQL Scripts"
          text="Review generated SQL scripts before approval."
        />

        <div className="script-card">
          <div className="script-header">
            <h2 className="script-card__title">Generated Scripts</h2>
            <button className="script-btn script-btn--primary">Approve</button>
          </div>

          <div className="script-codebox">
            {scripts.map((line, index) => (
              <div className="script-codebox__line" key={index}>
                {index + 1}. {line}
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}