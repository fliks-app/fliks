use crate::http::AppError;

const BCRYPT_COST: u32 = 12;

/// bcrypt at the one cost every stored hash uses (`auth.md` rule 30), off the async threads.
pub async fn hash_password(password: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || bcrypt::hash(password, BCRYPT_COST))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
        .map_err(|e| AppError::internal(e.to_string()))
}
