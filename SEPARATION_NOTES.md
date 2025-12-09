# Project Separation Notes

This backend project has been separated from the monorepo structure for independent deployment.

## Folder Structure

The project has been reorganized into two separate folders:

- **`sweepalgo-frontend/`** - React + Vite frontend application (separate folder)
- **`sweepalgo-backend/`** - Node.js + Express backend API (this folder)

## Deployment

Both projects can now be deployed independently:

### Frontend (Vercel)
- Repository: Can be in a separate GitHub repo or same repo with different root
- Root Directory: `sweepalgo-frontend`
- Environment Variable: `VITE_API_URL`

### Backend (Railway)
- Repository: Can be in a separate GitHub repo or same repo with different root
- Root Directory: `sweepalgo-backend`
- Environment Variables: `NODE_ENV`, `PORT`, `FRONTEND_URL`, `POLYGON_API_KEY`

## GitHub Repository Options

You have two options for GitHub repositories:

### Option 1: Separate Repositories (Recommended)
- `sweepalgo-frontend` - Frontend repository
- `sweepalgo-backend` - Backend repository

**Pros:**
- Independent version control
- Separate deployment pipelines
- Easier to manage permissions
- Cleaner structure

### Option 2: Monorepo with Separate Folders
- Single repository with both `sweepalgo-frontend` and `sweepalgo-backend` folders

**Pros:**
- Single repository to manage
- Shared code can be in root
- Easier to keep in sync

**Cons:**
- Need to specify root directory in deployment platforms
- Slightly more complex setup

## Migration Notes

- All backend files have been moved from `sweepalgo-main-app/backend/` to `sweepalgo-backend/`
- All frontend files have been moved from `sweepalgo-main-app/` to `sweepalgo-frontend/`
- Environment variable references remain the same
- API endpoints remain the same
- No code changes required - only folder structure changed

## Next Steps

1. **If using separate repositories:**
   - Create a new GitHub repository for `sweepalgo-backend`
   - Create a new GitHub repository for `sweepalgo-frontend`
   - Push each folder to its respective repository

2. **If using monorepo:**
   - Keep both folders in the same repository
   - Specify root directory when deploying to Vercel/Railway

3. **Deploy:**
   - Follow the instructions in [README.md](./README.md)

