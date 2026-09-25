import { NextResponse } from "next/server";
import { buildOpenApi } from "../../../openapi";

export const GET = () => NextResponse.json(buildOpenApi());
