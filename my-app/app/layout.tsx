import ClientProvider from "./clientProvider";
import "./globals.css";

export const metadata = {
  title: "DB Schema Control",
  description: "Simple prototype for schema comparison and version control",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ClientProvider>{children}</ClientProvider>
      </body>
    </html>
  );
}