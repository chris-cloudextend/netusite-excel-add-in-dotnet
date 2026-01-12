/*
 * XAVI for NetSuite - .NET Backend
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * ASP.NET Core Web API for NetSuite SuiteQL queries.
 * Provides REST endpoints for the XAVI Excel Add-in.
 */

using XaviApi.Configuration;
using XaviApi.Services;

var builder = WebApplication.CreateBuilder(args);

// =============================================================================
// Configuration
// =============================================================================

// Bind configuration sections
builder.Services.Configure<NetSuiteConfig>(builder.Configuration.GetSection(NetSuiteConfig.SectionName));
builder.Services.Configure<CorsConfig>(builder.Configuration.GetSection(CorsConfig.SectionName));
builder.Services.Configure<CacheConfig>(builder.Configuration.GetSection(CacheConfig.SectionName));

// =============================================================================
// Services
// =============================================================================

// Add controllers
builder.Services.AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.PropertyNamingPolicy = null; // Keep original casing
        options.JsonSerializerOptions.WriteIndented = true;
    });

// Add memory cache
builder.Services.AddMemoryCache();

// =============================================================================
// Performance Hardening: NetSuite Request Governor
// Handles concurrency control, throttling, and request deduplication
// for Excel-scale workloads (3000+ formulas)
// =============================================================================
builder.Services.AddSingleton<INetSuiteGovernor, NetSuiteGovernor>();

// Register NetSuiteService (creates its own HttpClient internally)
builder.Services.AddSingleton<INetSuiteService, NetSuiteService>();

// Register services
builder.Services.AddScoped<IBalanceService, BalanceService>();
builder.Services.AddScoped<ILookupService, LookupService>();
builder.Services.AddScoped<IBudgetService, BudgetService>();

// =============================================================================
// CORS Configuration
// =============================================================================

// Get allowed origins from configuration
var corsConfig = builder.Configuration.GetSection(CorsConfig.SectionName).Get<CorsConfig>();
var allowedOrigins = corsConfig?.AllowedOrigins ?? new[]
{
    "https://chris-cloudextend.github.io",
    "http://localhost:3000",
    "https://localhost:3000"
};

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowExcelAddin", policy =>
    {
        policy.WithOrigins(allowedOrigins)
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
    
    // Development policy - allows any origin
    options.AddPolicy("Development", policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

// =============================================================================
// Swagger/OpenAPI (for development)
// =============================================================================

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new Microsoft.OpenApi.Models.OpenApiInfo
    {
        Title = "XAVI for NetSuite API",
        Version = "v3.0.5",
        Description = "REST API for NetSuite SuiteQL queries - Excel Add-in Backend"
    });
});

// =============================================================================
// Build Application
// =============================================================================

var app = builder.Build();

// Validate configuration on startup
var netSuiteConfig = app.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<NetSuiteConfig>>().Value;
if (!netSuiteConfig.IsValid)
{
    app.Logger.LogWarning("⚠️  NetSuite configuration is incomplete!");
    app.Logger.LogWarning("   Please configure credentials in appsettings.json or environment variables:");
    app.Logger.LogWarning("   - NetSuite__AccountId");
    app.Logger.LogWarning("   - NetSuite__ConsumerKey");
    app.Logger.LogWarning("   - NetSuite__ConsumerSecret");
    app.Logger.LogWarning("   - NetSuite__TokenId");
    app.Logger.LogWarning("   - NetSuite__TokenSecret");
}
else
{
    app.Logger.LogInformation("✅ NetSuite configuration loaded for account: {AccountId}", netSuiteConfig.AccountId);
}

// Initialize accounting book to subsidiaries cache on startup (non-blocking)
_ = Task.Run(async () =>
{
    try
    {
        app.Logger.LogInformation("⏳ Starting book-subsidiary cache initialization in background...");
        // Wait a bit for services to be fully ready
        await Task.Delay(2000);
        
        app.Logger.LogInformation("🔧 Creating service scope for cache initialization...");
        using var scope = app.Services.CreateScope();
        var lookupService = scope.ServiceProvider.GetRequiredService<ILookupService>();
        if (lookupService is XaviApi.Services.LookupService service)
        {
            app.Logger.LogInformation("🚀 Calling InitializeBookSubsidiaryCacheAsync...");
            await service.InitializeBookSubsidiaryCacheAsync();
            app.Logger.LogInformation("✅ Cache initialization task completed");
        }
        else
        {
            app.Logger.LogWarning("⚠️ LookupService is not the expected type, cannot initialize cache");
        }
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "❌ Error initializing book-subsidiary cache on startup: {Message}", ex.Message);
    }
});

// =============================================================================
// Middleware Pipeline
// =============================================================================

// Global exception handler - catch unhandled exceptions and log them
app.UseExceptionHandler(appBuilder =>
{
    appBuilder.Run(async context =>
    {
        var exceptionHandlerPathFeature = context.Features.Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerPathFeature>();
        var exception = exceptionHandlerPathFeature?.Error;
        
        if (exception != null)
        {
            var logger = context.RequestServices.GetRequiredService<ILogger<Program>>();
            logger.LogError(exception, 
                "❌ Unhandled exception: {Message} | Path: {Path} | Method: {Method}",
                exception.Message, 
                context.Request.Path,
                context.Request.Method);
            
            context.Response.StatusCode = 500;
            context.Response.ContentType = "application/json";
            
            var errorResponse = new
            {
                error = "Internal server error",
                message = exception.Message,
                path = context.Request.Path.Value,
                method = context.Request.Method,
                timestamp = DateTime.UtcNow.ToString("o")
            };
            
            await context.Response.WriteAsJsonAsync(errorResponse);
        }
    });
});

// Enable Swagger in development
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI(c =>
    {
        c.SwaggerEndpoint("/swagger/v1/swagger.json", "XAVI API v3");
        c.RoutePrefix = "swagger";
    });
    
    // Use permissive CORS in development
    app.UseCors("Development");
}
else
{
    // Use restrictive CORS in production
    app.UseCors("AllowExcelAddin");
}

// Map controllers
app.MapControllers();

// =============================================================================
// Run Application
// =============================================================================

var port = Environment.GetEnvironmentVariable("PORT") ?? "5002";
app.Urls.Add($"http://localhost:{port}");

app.Logger.LogInformation("🚀 XAVI for NetSuite API starting on port {Port}", port);
app.Logger.LogInformation("   Swagger UI: http://localhost:{Port}/swagger", port);

app.Run();

