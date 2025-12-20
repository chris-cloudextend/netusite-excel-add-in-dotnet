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

// =============================================================================
// Middleware Pipeline
// =============================================================================

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

