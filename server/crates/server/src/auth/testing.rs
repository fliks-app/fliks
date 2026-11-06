//! Test tokens: every token is bound to a `sessions` row of its user.
use crate::state::AppState;

pub async fn new(st: &AppState, user: i32) -> i32 {
    sqlx::query_scalar(
        r#"INSERT INTO sessions ("userId", method) VALUES ($1, 'password') RETURNING id"#,
    )
    .bind(user)
    .fetch_one(&st.db)
    .await
    .unwrap()
}

/// An access token on a new session of `id`.
pub async fn token(st: &AppState, id: i32, name: &str) -> String {
    let sid = new(st, id).await;
    st.jwt.sign_access(id, name, sid).unwrap().token
}

/// An unbound stream token on a new session of `id`.
pub async fn stream(st: &AppState, id: i32, name: &str) -> String {
    let sid = new(st, id).await;
    st.jwt.sign_stream(id, name, sid).unwrap().token
}
