import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";

export default function ComparePage() {
  const rows = [
    {
      item: "users.email",
      type: "Column",
      change: "Modified",
      status: "Pending",
    },
    {
      item: "orders",
      type: "Table",
      change: "Added",
      status: "Approved",
    },
    {
      item: "idx_customer_name",
      type: "Index",
      change: "Removed",
      status: "Review",
    },
    {
      item: "payments.user_id",
      type: "Foreign Key",
      change: "Added",
      status: "Pending",
    },
  ];

  const getBadgeClass = (status: string) => {
    if (status === "Approved") {
      return "compare-badge compare-badge--approved";
    }
    if (status === "Pending") {
      return "compare-badge compare-badge--pending";
    }
    return "compare-badge compare-badge--review";
  };

  return (
    <div className="db-layout">
      <Sidebar current="Schema Comparison" />

      <main className="db-main">
        <Topbar
          title="Schema Comparison"
          text="Compare two schemas and check the differences."
        />

        <div className="compare-card">
          <h2 className="compare-card__title">Comparison Result</h2>

          <div className="compare-top">
            <select className="compare-select">
              <option>Schema A</option>
            </select>

            <select className="compare-select">
              <option>Schema B</option>
            </select>

            <button className="compare-btn compare-btn--primary">
              Compare
            </button>
          </div>

          <table className="compare-table">
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
                    <span className={getBadgeClass(row.status)}>
                      {row.status}
                    </span>
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