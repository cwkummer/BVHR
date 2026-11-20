// Type shim for the drizzle-kit generated Durable Object migrations bundle (plain JS, no declarations).
declare module "*/drizzle-do/migrations/migrations" {
  const migrations: {
    journal: { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] };
    migrations: Record<string, string>;
  };
  export default migrations;
}
