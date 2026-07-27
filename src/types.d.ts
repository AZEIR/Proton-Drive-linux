declare module "*.css" {
    const content: string;
    export default content;
}

declare module "*.js" {
    const content: string;
    export default content;
}

declare module "*.svg" {
    const content: string;
    export default content;
}

declare module "fuse-native";

declare module "better-sqlite3" {
    const Database: new (filename: string, options?: Record<string, unknown>) => any;
    export default Database;
}
