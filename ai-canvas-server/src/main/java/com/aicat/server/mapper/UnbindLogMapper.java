package com.aicat.server.mapper;

import com.aicat.server.entity.UnbindLog;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UnbindLogMapper extends BaseMapper<UnbindLog> {
    @Select("SELECT COUNT(*) FROM unbind_log WHERE user_id = #{userId} AND YEAR(created_at) = YEAR(NOW()) AND operator = 'user'")
    int countThisYear(Long userId);
}
