import { useState, useEffect } from "react";
import type { AppAccount } from "../utils.ts";
import { getContract, short, fetchJsonFromBulletin, asBytes20 } from "../utils.ts";
import type { PlayerData, Move } from "../types.ts";

const MOVE_EMOJI: Record<Move, string> = { rock: "✊", paper: "✋", scissors: "✂️" };

export default function MyProfile({ account }: {
    account: AppAccount;
}) {
    const [data, setData] = useState<PlayerData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setData(null);
        setError(null);
        (async () => {
            try {
                const lb = getContract();
                if (!lb) { setLoading(false); return; }

                const regRes = await lb.isRegistered.query(asBytes20(account));
                if (!regRes.success) throw new Error("Unable to read player registration");
                if (!regRes.value) {
                    setLoading(false);
                    return;
                }

                const cidRes = await lb.getPlayerCid.query(asBytes20(account));
                if (!cidRes.success) throw new Error("Unable to read player history");
                if (cancelled) return;
                if (!cidRes.value) {
                    const ptsRes = await lb.getPlayerPoints.query(asBytes20(account));
                    if (!ptsRes.success) throw new Error("Unable to read player points");
                    if (!cancelled) {
                        setData({
                            player: account.h160Address,
                            totalGames: 0, wins: 0, losses: 0, draws: 0,
                            points: ptsRes.success ? Number(ptsRes.value) : 0,
                            games: [],
                        });
                    }
                    setLoading(false);
                    return;
                }

                const history = await fetchJsonFromBulletin<PlayerData>(cidRes.value);
                if (!cancelled) setData(history);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load player history");
                console.error("[Profile] Error:", err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [account.h160Address]);

    if (loading) {
        return <div className="profile-card"><div className="spinner">Loading profile...</div></div>;
    }

    if (error) return <div className="empty" role="alert">{error}</div>;

    if (!data) {
        return (
            <div className="profile-card">
                <div className="profile-header">
                    <div className="profile-address">{short(account.h160Address)}</div>
                </div>
                <div className="profile-empty">No games yet — play your first match!</div>
            </div>
        );
    }

    const winRate = data.totalGames > 0 ? Math.round((data.wins / data.totalGames) * 100) : 0;

    return (
        <div className="profile-card">
            <div className="profile-header" onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer" }}>
                <div>
                    <div className="profile-address">{short(account.h160Address)}</div>
                    <div className="profile-points">
                        {data.points > 0 ? `+${data.points}` : data.points} pts
                    </div>
                </div>
                <div className="profile-stats-mini">
                    <span className="profile-stat-win">{data.wins}W</span>
                    <span className="profile-stat-loss">{data.losses}L</span>
                    <span className="profile-stat-draw">{data.draws}D</span>
                    <span className="profile-stat-rate">{winRate}%</span>
                    <span className="profile-expand">{expanded ? "▲" : "▼"}</span>
                </div>
            </div>

            {expanded && data.games.length > 0 && (
                <div className="profile-games">
                    {data.games.slice().reverse().slice(0, 10).map(game => (
                        <div key={game.id} className="profile-game-row">
                            <span className="profile-game-mode">{game.mode === "solo" ? "vs CPU" : "vs " + short(game.opponent)}</span>
                            <span className="profile-game-rounds">
                                {game.rounds.map((r, i) => (
                                    <span key={i} title={`${r.playerMove} vs ${r.opponentMove}`}>
                                        {MOVE_EMOJI[r.playerMove]}
                                    </span>
                                ))}
                            </span>
                            <span className={`profile-game-result ${game.result}`}>
                                {game.result === "win" ? "W" : game.result === "loss" ? "L" : "D"}
                            </span>
                            <span className="profile-game-pts">
                                {game.pointsChange > 0 ? `+${game.pointsChange}` : game.pointsChange}
                            </span>
                        </div>
                    ))}
                    {data.games.length > 10 && (
                        <div className="profile-more">...and {data.games.length - 10} more</div>
                    )}
                </div>
            )}

            {expanded && data.games.length === 0 && (
                <div className="profile-empty">No games yet</div>
            )}
        </div>
    );
}
