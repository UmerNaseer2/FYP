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

        <div className="db-card">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "16px",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <div className="db-card__title" style={{ marginBottom: 0 }}>
              Generated Scripts
            </div>
            <button className="db-btn db-btn--primary">Approve</button>
          </div>

          <div className="db-codebox">
            {scripts.map((line, index) => (
              <div className="db-codebox__line" key={index}>
                {index + 1}. {line}
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}