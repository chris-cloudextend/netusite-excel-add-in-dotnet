# XAVI for NetSuite - .NET Backend

ASP.NET Core Web API backend for the XAVI Excel Add-in. Provides REST endpoints for NetSuite SuiteQL queries.

## Prerequisites

- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- NetSuite OAuth 1.0 credentials (Consumer Key/Secret, Token ID/Secret)

## Quick Start

### 1. Install .NET SDK

**macOS (Homebrew):**
```bash
brew install dotnet@8
```

**macOS (Installer):**
Download from https://dotnet.microsoft.com/download/dotnet/8.0

**Windows:**
Download installer from https://dotnet.microsoft.com/download/dotnet/8.0

### 2. Configure Credentials

Copy the template and add your NetSuite credentials:

```bash
cd backend-dotnet
cp appsettings.Development.json.template appsettings.Development.json
```

Edit `appsettings.Development.json` with your credentials:

```json
{
  "NetSuite": {
    "AccountId": "1234567",
    "ConsumerKey": "your-consumer-key",
    "ConsumerSecret": "your-consumer-secret",
    "TokenId": "your-token-id",
    "TokenSecret": "your-token-secret"
  }
}
```

**Alternative: Environment Variables**

```bash
export NetSuite__AccountId="1234567"
export NetSuite__ConsumerKey="your-consumer-key"
export NetSuite__ConsumerSecret="your-consumer-secret"
export NetSuite__TokenId="your-token-id"
export NetSuite__TokenSecret="your-token-secret"
```

### 3. Run the API

```bash
cd backend-dotnet
dotnet restore
dotnet run
```

The API will start on http://localhost:5002

### 4. Test the Connection

```bash
curl http://localhost:5002/health
curl http://localhost:5002/test
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info and version |
| `/health` | GET | Health check |
| `/test` | GET | Test NetSuite connection |
| `/balance` | GET | Get account balance |
| `/type-balance` | POST | Get balance by account type |
| `/batch/balance` | POST | Batch balance query |
| `/batch/full_year_refresh` | POST | Full year P&L refresh |
| `/lookups/all` | GET | Get all lookups |
| `/subsidiaries` | GET | Get subsidiaries |
| `/departments` | GET | Get departments |
| `/classes` | GET | Get classes |
| `/locations` | GET | Get locations |
| `/budget` | GET | Get budget amount |
| `/batch/budget` | POST | Batch budget query |
| `/account/name` | POST | Get account name |
| `/account/type` | POST | Get account type |

## Development

### Run with Hot Reload

```bash
dotnet watch run
```

### Swagger UI

Available in development mode at: http://localhost:5002/swagger

### Project Structure

```
backend-dotnet/
├── Controllers/
│   ├── HealthController.cs      # Health check endpoints
│   ├── BalanceController.cs     # GL balance queries
│   ├── TypeBalanceController.cs # Type balance queries
│   ├── LookupController.cs      # Reference data lookups
│   ├── AccountController.cs     # Account queries
│   └── BudgetController.cs      # Budget queries
├── Services/
│   ├── NetSuiteService.cs       # Core NetSuite API service
│   ├── OAuth1Helper.cs          # OAuth 1.0 signature generator
│   ├── BalanceService.cs        # Balance calculation logic
│   ├── LookupService.cs         # Lookup/reference data
│   └── BudgetService.cs         # Budget queries
├── Models/
│   ├── AccountTypes.cs          # Account type constants
│   ├── BalanceModels.cs         # Balance DTOs
│   ├── BudgetModels.cs          # Budget DTOs
│   ├── LookupModels.cs          # Lookup DTOs
│   ├── TransactionModels.cs     # Transaction DTOs
│   └── SpecialFormulaModels.cs  # RE, NI, CTA DTOs
├── Configuration/
│   └── NetSuiteConfig.cs        # Config classes
├── Program.cs                   # App entry point
├── appsettings.json             # Base configuration
└── appsettings.Development.json # Dev credentials (gitignored)
```

## Deployment

### Using Cloudflare Tunnel

```bash
# Run the API
dotnet run

# In another terminal, start the tunnel
cloudflared tunnel --url http://localhost:5002
```

Update the Cloudflare Worker with the tunnel URL.

### Docker (Coming Soon)

```bash
docker build -t xavi-api .
docker run -p 5002:5002 xavi-api
```

## Migration from Python

This .NET backend replaces the Python Flask backend (`backend/server.py`). The API endpoints are compatible - the Excel Add-in works with either backend.

Key differences:
- OAuth 1.0 implemented using HMAC-SHA256 (same as Python)
- Uses ASP.NET Core dependency injection
- In-memory caching with `IMemoryCache`
- Swagger/OpenAPI documentation

## Troubleshooting

### "NetSuite configuration is incomplete"

Ensure all five credential fields are set:
- AccountId
- ConsumerKey
- ConsumerSecret
- TokenId
- TokenSecret

### Connection Timeout

NetSuite API calls have a 60-second timeout. For slow queries:
1. Check your NetSuite account permissions
2. Verify the account ID format (include `_SB1` for sandbox)
3. Test with simpler queries first

### CORS Errors

The API allows requests from:
- `https://chris-cloudextend.github.io`
- `http://localhost:3000`
- `https://localhost:3000`

Add additional origins in `appsettings.json` under `Cors.AllowedOrigins`.

---

*Version: 3.0.5.233*
*Copyright (c) 2025 Celigo, Inc.*

