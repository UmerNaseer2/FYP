import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";

export default function ComparePage() {
  const rows = [
    { item: "users.email", type: "Column", change: "Modified", status: "Pending" },
    { item: "orders", type: "Table", change: "Added", status: "Approved" },
    { item: "idx_customer_name", type: "Index", change: "Removed", status: "Pending" },
    { item: "payments.user_id", type: "Foreign Key", change: "Added", status: "Review" },
  ];

  const getBadge = (status: string) => {
    if (status === "Approved") return "db-badge db-badge--approved";
    if (status === "Pending") return "db-badge db-badge--pending";
    return "db-badge db-badge--review";
  };

  return (
    <div className="db-layout">
      <Sidebar current="Schema Comparison" />

      <main className="db-main">
        <Topbar
          title="Schema Comparison"
          text="Compare two schemas and check the differences."
        />

        <div className="db-card">
          <div className="db-card__title">Comparison Result</div>

          <div className="db-form__row" style={{ marginBottom: "16px" }}>
            <select className="db-form__select">
              <option>Schema A</option>
            </select>
            <select className="db-form__select">
              <option>Schema B</option>
            </select>
          </div>

          <button className="db-btn db-btn--primary" style={{ marginBottom: "16px" }}>
            Compare
          </button>

          <table className="db-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Type</th>
                <th>Change</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.item}>
                  <td>{row.item}</td>
                  <td>{row.type}</td>
                  <td>{row.change}</td>
                  <td>
                    <span className={getBadge(row.status)}>{row.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}