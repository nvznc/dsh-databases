/*
 * Crea (o actualiza la contraseña de) el login `mcp_sql` y le da acceso a todas
 * las bases de usuario en línea.
 *
 * Uso:
 *   sqlcmd -S localhost -E -C -i sql/create-mcp-login.sql -v McpPassword="TuClaveSegura1!"
 *
 * Requisitos: ejecutarse con una cuenta sysadmin (p. ej. tu login de Windows).
 */
:setvar McpPassword "CambiaEstaClave1!"

IF SUSER_ID('mcp_sql') IS NULL
    EXEC('CREATE LOGIN [mcp_sql] WITH PASSWORD = N''$(McpPassword)'', CHECK_POLICY = ON, DEFAULT_DATABASE = [master];');
ELSE
    EXEC('ALTER LOGIN [mcp_sql] WITH PASSWORD = N''$(McpPassword)'';');
GO

GRANT VIEW SERVER STATE TO [mcp_sql];
GRANT VIEW ANY DEFINITION TO [mcp_sql];
GO

DECLARE @db sysname, @readOnly bit, @cmd nvarchar(max);
DECLARE dbs CURSOR LOCAL FAST_FORWARD FOR
    SELECT name, is_read_only
    FROM sys.databases
    WHERE database_id > 4 AND state = 0
    ORDER BY name;

OPEN dbs;
FETCH NEXT FROM dbs INTO @db, @readOnly;

WHILE @@FETCH_STATUS = 0
BEGIN
    SET @cmd = N'USE ' + QUOTENAME(@db) + N';
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N''mcp_sql'')
    CREATE USER [mcp_sql] FOR LOGIN [mcp_sql];
ALTER ROLE db_datareader ADD MEMBER [mcp_sql];
GRANT VIEW DEFINITION TO [mcp_sql];
GRANT EXECUTE TO [mcp_sql];';

    IF @readOnly = 0
        SET @cmd = @cmd + N'
ALTER ROLE db_datawriter ADD MEMBER [mcp_sql];
ALTER ROLE db_ddladmin ADD MEMBER [mcp_sql];';

    EXEC sys.sp_executesql @cmd;
    FETCH NEXT FROM dbs INTO @db, @readOnly;
END

CLOSE dbs;
DEALLOCATE dbs;
GO

PRINT 'Login mcp_sql listo.';
