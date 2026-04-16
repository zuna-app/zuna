package rest

type HttpErrorResponse struct {
	Error string `json:"error"`
}

var (
	InternalServerError = HttpErrorResponse{Error: "internal server error"}
	BadRequest          = HttpErrorResponse{Error: "bad request"}
	Unauthorized        = HttpErrorResponse{Error: "unauthorized"}
	Forbidden           = HttpErrorResponse{Error: "forbidden"}
)
