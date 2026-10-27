/*
 * Elimina el login `mcp_sql` y sus usuarios de todas las bases de usuario.
 *
 * Uso: sqlcmd -S localhost -E -C -i sql/drop-mcp-login.sql
 */
DECLARE @db sysname, @cmd nvarchar(max);
DECLARE dbs CURSOR LOCAL FAST_FORWARD FOR
    SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0;

OPEN dbs;
FETCH NEXT FROM dbs INTO @db;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @cmd = N'USE ' + QUOTENAME(@db) + N';
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N''mcp_sql'')
    DROP USER [mcp_sql];';
    EXEC sys.sp_executesql @cmd;
    FETCH NEXT FROM dbs INTO @db;
END
CLOSE dbs;
DEALLOCATE dbs;
GO

IF SUSER_ID('mcp_sql') IS NOT NULL
    DROP LOGIN [mcp_sql];
GO

PRINT 'Login mcp_sql eliminado.';
